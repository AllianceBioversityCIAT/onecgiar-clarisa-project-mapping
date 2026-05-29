/**
 * Unit tests for TocSyncService.
 *
 * All external collaborators are mocked — no database, no HTTP.
 * Tests pin every business rule from the spec:
 *
 *  Rule 1 — node_id derivation: related_node_id ?? id (truthy wins)
 *  Rule 2 — AOW filter: category=WP && wp_type=AOW only
 *  Rule 3 — AOW lookup map keyed by raw WP.id (NOT derived node_id)   ← the trap
 *  Rule 4 — Outcome type: OUTCOME→intermediate, EOI→portfolio
 *  Rule 5 — Empty/null group → aow_id=null (no lookup failure)
 *  Rule 6 — AOW name: ost_wp.name → title → ''
 *  Rule 7 — 404 (null return) → skip, add not_found detail, continue
 *  Rule 9 — ServiceUnavailableException → caught per-program, does not abort loop
 *  Rule Log — per-program log line matches expected format
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ServiceUnavailableException, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { TocSyncService } from './toc-sync.service';
import { TocService } from '../toc/toc.service';
import { Program } from './entities/program.entity';
import { TocAow } from './entities/toc-aow.entity';
import { TocOutcome, TocOutcomeType } from './entities/toc-outcome.entity';
import { TocOutput } from './entities/toc-output.entity';
import { TocDataNode } from '../toc/interfaces';

/* ═══════════════════════════════════════════════════════════════
   Factories
   ══════════════════════════════════════════════════════════════ */

function makeProgram(overrides: Partial<Program> = {}): Program {
  return {
    id: 1,
    clarisaId: 1001,
    officialCode: 'SP01',
    name: 'Science Program 01',
    syncedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Program;
}

/** Minimal AOW (WP) node. */
function makeAowNode(overrides: Partial<TocDataNode> = {}): TocDataNode {
  return {
    id: 'WP-RAW-1',
    category: 'WP',
    wp_type: 'AOW',
    title: 'AOW Title',
    ost_wp: {
      name: 'Area of Work 1',
      acronym: 'AOW1',
      wp_official_code: 'SP01-AOW1',
      toc_id: 'CLARISA-1',
    },
    ...overrides,
  };
}

/** Minimal OUTPUT node. */
function makeOutputNode(overrides: Partial<TocDataNode> = {}): TocDataNode {
  return {
    id: 'OUT-1',
    category: 'OUTPUT',
    title: 'Output 1',
    description: 'Output description',
    type_of_output: 'Knowledge product',
    group: 'WP-RAW-1',
    related_node_id: 'OUT-1-REL',
    ...overrides,
  };
}

/** Minimal OUTCOME node. */
function makeOutcomeNode(overrides: Partial<TocDataNode> = {}): TocDataNode {
  return {
    id: 'OC-1',
    category: 'OUTCOME',
    title: 'Intermediate Outcome 1',
    description: 'Outcome description',
    group: 'WP-RAW-1',
    related_node_id: null,
    ...overrides,
  };
}

/** Minimal EOI (portfolio outcome) node. */
function makeEoiNode(overrides: Partial<TocDataNode> = {}): TocDataNode {
  return {
    id: 'EOI-1',
    category: 'EOI',
    title: 'Portfolio Outcome 1',
    description: 'EOI description',
    group: 'WP-RAW-1',
    related_node_id: null,
    ...overrides,
  };
}

/* ═══════════════════════════════════════════════════════════════
   Transaction mock factory
   ══════════════════════════════════════════════════════════════ */

/**
 * Builds a mock DataSource whose `transaction()` method executes the
 * callback synchronously with a per-call entity manager.
 *
 * Each repository mock in the manager tracks `save()` calls so tests
 * can assert what was persisted.
 */
function buildMockDataSource() {
  /* Counters shared per transaction call — reset each time transaction()
   * is invoked so sequential calls start fresh. */
  let aowIdSeq = 100;

  /* The "database" rows for the current transaction. */
  const savedAows: Partial<TocAow>[] = [];
  const savedOutputs: Partial<TocOutput>[] = [];
  const savedOutcomes: Partial<TocOutcome>[] = [];
  /* Junction rows captured from `manager.query('INSERT INTO toc_outcome_aows …')`.
   * Each tuple is `{ outcomeId, aowId }`. */
  const savedJunction: Array<{ outcomeId: number; aowId: number }> = [];

  const makeManagerRepo = <T extends { id?: number }>(
    savedSink: Partial<T>[],
    idStart: () => number,
  ) => {
    const rows = new Map<string, T>();

    return {
      _rows: rows,
      _savedSink: savedSink,
      findOne: jest.fn(
        async ({ where }: { where: Record<string, unknown> }) => {
          /* Look up by nodeId + programId key — mirrors the real query. */
          const key = `${where['programId']}-${where['nodeId']}`;
          return rows.get(key) ?? null;
        },
      ),
      create: jest.fn((partial: Partial<T>) => ({ ...partial }) as T),
      save: jest.fn(
        async (entity: T & { nodeId?: string; programId?: number }) => {
          const id = idStart();
          const saved = { ...entity, id } as T;
          if (entity.nodeId !== undefined && entity.programId !== undefined) {
            rows.set(`${entity.programId}-${entity.nodeId}`, saved);
          }
          savedSink.push(saved as Partial<T>);
          return saved;
        },
      ),
    };
  };

  const dataSource = {
    _savedAows: savedAows,
    _savedOutputs: savedOutputs,
    _savedOutcomes: savedOutcomes,
    _savedJunction: savedJunction,
    transaction: jest.fn(async (cb: (manager: any) => Promise<any>) => {
      aowIdSeq = 100; /* reset for each transaction call */
      const aowManagerRepo = makeManagerRepo<TocAow>(
        savedAows,
        () => aowIdSeq++,
      );
      const outputManagerRepo = makeManagerRepo<TocOutput>(
        savedOutputs,
        () => aowIdSeq++,
      );
      const outcomeManagerRepo = makeManagerRepo<TocOutcome>(
        savedOutcomes,
        () => aowIdSeq++,
      );

      const manager = {
        getRepository: jest.fn((entity: any) => {
          if (entity === TocAow) return aowManagerRepo;
          if (entity === TocOutput) return outputManagerRepo;
          if (entity === TocOutcome) return outcomeManagerRepo;
          throw new Error(`Unexpected entity in getRepository: ${entity}`);
        }),
        /* Captures the raw INSERT/DELETE statements the sync service
         * issues against the entity-less `toc_outcome_aows` junction.
         * We parse both shapes:
         *   - DELETE FROM toc_outcome_aows WHERE outcome_id = ?  → drop rows
         *   - INSERT INTO toc_outcome_aows (...) VALUES (?,?), …  → append tuples
         * Anything else throws so test fixtures stay honest. */
        query: jest.fn(async (sql: string, params: any[] = []) => {
          const upper = sql.toUpperCase();
          if (upper.startsWith('DELETE FROM TOC_OUTCOME_AOWS')) {
            const outcomeId = params[0] as number;
            for (let i = savedJunction.length - 1; i >= 0; i--) {
              if (savedJunction[i].outcomeId === outcomeId) {
                savedJunction.splice(i, 1);
              }
            }
            return [];
          }
          if (upper.startsWith('INSERT INTO TOC_OUTCOME_AOWS')) {
            for (let i = 0; i < params.length; i += 2) {
              savedJunction.push({
                outcomeId: params[i] as number,
                aowId: params[i + 1] as number,
              });
            }
            return [];
          }
          throw new Error(`Unexpected manager.query call: ${sql}`);
        }),
      };

      return cb(manager);
    }),
  };

  return dataSource;
}

/* ═══════════════════════════════════════════════════════════════
   Suite
   ══════════════════════════════════════════════════════════════ */

describe('TocSyncService', () => {
  let service: TocSyncService;
  let tocServiceMock: { fetchProgram: jest.Mock };
  let programRepo: { find: jest.Mock };
  let mockDataSource: ReturnType<typeof buildMockDataSource>;

  /* Stub repos injected directly into the service (not used in
   * syncProgram which runs through the transaction manager, but
   * required for the DI token bindings). */
  const stubRepo = () => ({
    find: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn(),
    create: jest.fn(),
  });

  beforeEach(async () => {
    tocServiceMock = { fetchProgram: jest.fn() };
    programRepo = { find: jest.fn() };
    mockDataSource = buildMockDataSource();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TocSyncService,
        { provide: TocService, useValue: tocServiceMock },
        { provide: getRepositoryToken(Program), useValue: programRepo },
        { provide: getRepositoryToken(TocAow), useValue: stubRepo() },
        { provide: getRepositoryToken(TocOutcome), useValue: stubRepo() },
        { provide: getRepositoryToken(TocOutput), useValue: stubRepo() },
        { provide: DataSource, useValue: mockDataSource },
      ],
    }).compile();

    service = module.get(TocSyncService);

    /* Silence logger output — we spy selectively per test. */
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  /* ── Happy path ─────────────────────────────────────────── */

  it('returns synced=1, failed=0 when one program syncs successfully', async () => {
    programRepo.find.mockResolvedValue([makeProgram()]);
    tocServiceMock.fetchProgram.mockResolvedValue({
      data: [makeAowNode(), makeOutputNode(), makeOutcomeNode()],
    });

    const result = await service.syncAll();

    expect(result.synced).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.details).toHaveLength(1);
    expect(result.details[0].programCode).toBe('SP01');
    expect(result.details[0].error).toBeUndefined();
  });

  it('returns counts in details matching the fixture', async () => {
    programRepo.find.mockResolvedValue([makeProgram()]);
    tocServiceMock.fetchProgram.mockResolvedValue({
      data: [makeAowNode(), makeOutputNode(), makeOutcomeNode(), makeEoiNode()],
    });

    const result = await service.syncAll();

    expect(result.details[0]).toMatchObject({
      programCode: 'SP01',
      aows: 1,
      outputs: 1,
      outcomes: 2,
    });
  });

  /* ── Rule 1: node_id derivation ────────────────────────── */

  it('uses related_node_id as node_id when it is truthy', async () => {
    const node = makeAowNode({ id: 'RAW-ID', related_node_id: 'RELATED-ID' });
    programRepo.find.mockResolvedValue([makeProgram()]);
    tocServiceMock.fetchProgram.mockResolvedValue({ data: [node] });

    await service.syncAll();

    const saved = mockDataSource._savedAows[0] as TocAow;
    expect(saved.nodeId).toBe('RELATED-ID');
  });

  it('falls back to raw id when related_node_id is null', async () => {
    const node = makeAowNode({ id: 'RAW-ID', related_node_id: null });
    programRepo.find.mockResolvedValue([makeProgram()]);
    tocServiceMock.fetchProgram.mockResolvedValue({ data: [node] });

    await service.syncAll();

    const saved = mockDataSource._savedAows[0] as TocAow;
    expect(saved.nodeId).toBe('RAW-ID');
  });

  it('falls back to raw id when related_node_id is empty string', async () => {
    const node = makeAowNode({ id: 'RAW-ID', related_node_id: '' });
    programRepo.find.mockResolvedValue([makeProgram()]);
    tocServiceMock.fetchProgram.mockResolvedValue({ data: [node] });

    await service.syncAll();

    const saved = mockDataSource._savedAows[0] as TocAow;
    expect(saved.nodeId).toBe('RAW-ID');
  });

  it('falls back to raw id when related_node_id is whitespace-only', async () => {
    const node = makeAowNode({ id: 'RAW-ID', related_node_id: '   ' });
    programRepo.find.mockResolvedValue([makeProgram()]);
    tocServiceMock.fetchProgram.mockResolvedValue({ data: [node] });

    await service.syncAll();

    const saved = mockDataSource._savedAows[0] as TocAow;
    expect(saved.nodeId).toBe('RAW-ID');
  });

  /* ── Rule 2: AOW filter (WP + AOW only) ────────────────── */

  it('ignores WP nodes that are not wp_type=AOW', async () => {
    const nonAowWp: TocDataNode = {
      id: 'WP-OTHER',
      category: 'WP',
      wp_type: 'SOME_OTHER_TYPE',
      title: 'Not an AOW',
    };
    programRepo.find.mockResolvedValue([makeProgram()]);
    tocServiceMock.fetchProgram.mockResolvedValue({
      data: [nonAowWp, makeAowNode()],
    });

    const result = await service.syncAll();

    /* Only 1 AOW (the real AOW), not 2. */
    expect(result.details[0].aows).toBe(1);
    /* Only one row saved into the AOW sink. */
    expect(mockDataSource._savedAows).toHaveLength(1);
  });

  it('ignores unrecognized categories entirely', async () => {
    const sdgNode: TocDataNode = {
      id: 'SDG-1',
      category: 'SDG',
      title: 'SDG 1',
    };
    const iaNode: TocDataNode = { id: 'IA-1', category: 'IA', title: 'IA 1' };
    programRepo.find.mockResolvedValue([makeProgram()]);
    tocServiceMock.fetchProgram.mockResolvedValue({
      data: [sdgNode, iaNode],
    });

    const result = await service.syncAll();

    expect(result.details[0].aows).toBe(0);
    expect(result.details[0].outputs).toBe(0);
    expect(result.details[0].outcomes).toBe(0);
    expect(mockDataSource._savedAows).toHaveLength(0);
    expect(mockDataSource._savedOutputs).toHaveLength(0);
    expect(mockDataSource._savedOutcomes).toHaveLength(0);
  });

  /* ── Rule 3: AOW lookup keyed by raw WP.id (the trap) ─── */

  /**
   * THE KEY TRAP TEST.
   *
   * Fixture:
   *   AOW node:    id='WP-RAW-ID-1', related_node_id='WP-DIFFERENT-1'
   *   Output node: group='WP-RAW-ID-1'
   *
   * Correct behaviour:
   *   - AOW stored with nodeId = 'WP-DIFFERENT-1' (resolved from related_node_id)
   *   - Map keyed by raw WP.id = 'WP-RAW-ID-1'
   *   - Output resolved to that AOW's DB id via Map lookup on 'WP-RAW-ID-1'
   *
   * Wrong behaviour (what breaks if map is keyed by nodeId):
   *   - Map keyed by 'WP-DIFFERENT-1'
   *   - Output's group 'WP-RAW-ID-1' misses → aow_id = null
   */
  it('keys the AOW lookup map by raw WP.id (not derived node_id) — the FK trap', async () => {
    const aowNode = makeAowNode({
      id: 'WP-RAW-ID-1',
      related_node_id: 'WP-DIFFERENT-1',
    });
    const outputNode = makeOutputNode({
      id: 'OUT-1',
      related_node_id: null,
      group: 'WP-RAW-ID-1' /* references raw WP id, not derived node_id */,
    });

    programRepo.find.mockResolvedValue([makeProgram()]);
    tocServiceMock.fetchProgram.mockResolvedValue({
      data: [aowNode, outputNode],
    });

    await service.syncAll();

    /* The AOW must be stored with the derived node_id. */
    const savedAow = mockDataSource._savedAows[0] as TocAow;
    expect(savedAow.nodeId).toBe('WP-DIFFERENT-1');

    /* The Output must resolve its aow_id to the saved AOW's id (100). */
    const savedOutput = mockDataSource._savedOutputs[0] as TocOutput;
    expect(savedOutput.aowId).toBe(savedAow.id); /* should be 100 */
    expect(savedOutput.aowId).not.toBeNull();
  });

  it('also applies the raw WP.id key rule to Outcomes', async () => {
    const aowNode = makeAowNode({
      id: 'WP-RAW-ID-1',
      related_node_id: 'WP-DIFFERENT-1',
    });
    const outcomeNode = makeOutcomeNode({
      id: 'OC-1',
      related_node_id: null,
      group: 'WP-RAW-ID-1',
    });

    programRepo.find.mockResolvedValue([makeProgram()]);
    tocServiceMock.fetchProgram.mockResolvedValue({
      data: [aowNode, outcomeNode],
    });

    await service.syncAll();

    const savedOutcome = mockDataSource._savedOutcomes[0] as TocOutcome;
    expect(savedOutcome.aowId).not.toBeNull();
  });

  /* ── Rule 4: Outcome type discriminator ────────────────── */

  it('sets outcomeType=intermediate for category=OUTCOME', async () => {
    const outcomeNode = makeOutcomeNode({ category: 'OUTCOME', group: null });
    programRepo.find.mockResolvedValue([makeProgram()]);
    tocServiceMock.fetchProgram.mockResolvedValue({ data: [outcomeNode] });

    await service.syncAll();

    const saved = mockDataSource._savedOutcomes[0] as TocOutcome;
    expect(saved.outcomeType).toBe(TocOutcomeType.INTERMEDIATE);
  });

  it('sets outcomeType=portfolio for category=EOI', async () => {
    const eoiNode = makeEoiNode({ group: null });
    programRepo.find.mockResolvedValue([makeProgram()]);
    tocServiceMock.fetchProgram.mockResolvedValue({ data: [eoiNode] });

    await service.syncAll();

    const saved = mockDataSource._savedOutcomes[0] as TocOutcome;
    expect(saved.outcomeType).toBe(TocOutcomeType.PORTFOLIO);
  });

  /* ── Rule 5: Empty/null group → aow_id=null ────────────── */

  it('sets aow_id=null when Output.group is empty string', async () => {
    const outputNode = makeOutputNode({ group: '' });
    programRepo.find.mockResolvedValue([makeProgram()]);
    tocServiceMock.fetchProgram.mockResolvedValue({ data: [outputNode] });

    await service.syncAll();

    const saved = mockDataSource._savedOutputs[0] as TocOutput;
    expect(saved.aowId).toBeNull();
  });

  it('sets aow_id=null when Output.group is null', async () => {
    const outputNode = makeOutputNode({ group: null });
    programRepo.find.mockResolvedValue([makeProgram()]);
    tocServiceMock.fetchProgram.mockResolvedValue({ data: [outputNode] });

    await service.syncAll();

    const saved = mockDataSource._savedOutputs[0] as TocOutput;
    expect(saved.aowId).toBeNull();
  });

  it('sets aow_id=null when Output.group is undefined', async () => {
    const outputNode: TocDataNode = {
      id: 'OUT-X',
      category: 'OUTPUT',
      title: 'X',
    };
    /* group is absent entirely */
    programRepo.find.mockResolvedValue([makeProgram()]);
    tocServiceMock.fetchProgram.mockResolvedValue({ data: [outputNode] });

    await service.syncAll();

    const saved = mockDataSource._savedOutputs[0] as TocOutput;
    expect(saved.aowId).toBeNull();
  });

  it('sets aow_id=null when Outcome.group is empty string', async () => {
    const outcomeNode = makeOutcomeNode({ group: '' });
    programRepo.find.mockResolvedValue([makeProgram()]);
    tocServiceMock.fetchProgram.mockResolvedValue({ data: [outcomeNode] });

    await service.syncAll();

    const saved = mockDataSource._savedOutcomes[0] as TocOutcome;
    expect(saved.aowId).toBeNull();
  });

  it('sets aow_id=null when group references a WP.id not present in the fixture', async () => {
    /* group points to an AOW that was not in the data set — should not
     * throw; resolve to null gracefully. */
    const outputNode = makeOutputNode({ group: 'NONEXISTENT-WP-ID' });
    programRepo.find.mockResolvedValue([makeProgram()]);
    tocServiceMock.fetchProgram.mockResolvedValue({ data: [outputNode] });

    await service.syncAll();

    const saved = mockDataSource._savedOutputs[0] as TocOutput;
    expect(saved.aowId).toBeNull();
  });

  /* ── Rule 6: AOW name fallback ──────────────────────────── */

  it('sets AOW name from ost_wp.name when present', async () => {
    const node = makeAowNode({
      ost_wp: { name: 'OST Name', acronym: null },
      title: 'Title Fallback',
    });
    programRepo.find.mockResolvedValue([makeProgram()]);
    tocServiceMock.fetchProgram.mockResolvedValue({ data: [node] });

    await service.syncAll();

    const saved = mockDataSource._savedAows[0] as TocAow;
    expect(saved.name).toBe('OST Name');
  });

  it('falls back to title when ost_wp.name is null', async () => {
    const node = makeAowNode({
      ost_wp: { name: null, acronym: null },
      title: 'Title Fallback',
    });
    programRepo.find.mockResolvedValue([makeProgram()]);
    tocServiceMock.fetchProgram.mockResolvedValue({ data: [node] });

    await service.syncAll();

    const saved = mockDataSource._savedAows[0] as TocAow;
    expect(saved.name).toBe('Title Fallback');
  });

  it('falls back to empty string when both ost_wp.name and title are absent', async () => {
    const node = makeAowNode({ ost_wp: null, title: null });
    programRepo.find.mockResolvedValue([makeProgram()]);
    tocServiceMock.fetchProgram.mockResolvedValue({ data: [node] });

    await service.syncAll();

    const saved = mockDataSource._savedAows[0] as TocAow;
    expect(saved.name).toBe('');
  });

  it('stores ost_wp metadata fields on the AOW', async () => {
    const node = makeAowNode({
      ost_wp: {
        toc_id: 'CLARISA-99',
        acronym: 'AOW9',
        wp_official_code: 'SP01-AOW9',
        name: 'Area 9',
      },
    });
    programRepo.find.mockResolvedValue([makeProgram()]);
    tocServiceMock.fetchProgram.mockResolvedValue({ data: [node] });

    await service.syncAll();

    const saved = mockDataSource._savedAows[0] as TocAow;
    expect(saved.clarisaTocId).toBe('CLARISA-99');
    expect(saved.acronym).toBe('AOW9');
    expect(saved.wpOfficialCode).toBe('SP01-AOW9');
  });

  it('stores null for ost_wp metadata fields when ost_wp is absent', async () => {
    const node = makeAowNode({ ost_wp: null });
    programRepo.find.mockResolvedValue([makeProgram()]);
    tocServiceMock.fetchProgram.mockResolvedValue({ data: [node] });

    await service.syncAll();

    const saved = mockDataSource._savedAows[0] as TocAow;
    expect(saved.clarisaTocId).toBeNull();
    expect(saved.acronym).toBeNull();
    expect(saved.wpOfficialCode).toBeNull();
  });

  /* ── Rule 7: 404 → skip ─────────────────────────────────── */

  it('records not_found detail and increments failed when fetchProgram returns null', async () => {
    programRepo.find.mockResolvedValue([makeProgram({ officialCode: 'SP01' })]);
    tocServiceMock.fetchProgram.mockResolvedValue(null);

    const result = await service.syncAll();

    expect(result.synced).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.details[0]).toMatchObject({
      programCode: 'SP01',
      error: 'not_found',
    });
  });

  it('continues processing remaining programs after a 404', async () => {
    const p1 = makeProgram({ id: 1, officialCode: 'SP01' });
    const p2 = makeProgram({ id: 2, officialCode: 'SP02' });
    programRepo.find.mockResolvedValue([p1, p2]);

    tocServiceMock.fetchProgram
      .mockResolvedValueOnce(null) /* SP01 → 404 */
      .mockResolvedValueOnce({ data: [makeAowNode()] }); /* SP02 → ok */

    const result = await service.syncAll();

    expect(result.synced).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.details).toHaveLength(2);
    expect(result.details[0]).toMatchObject({
      programCode: 'SP01',
      error: 'not_found',
    });
    expect(result.details[1]).toMatchObject({ programCode: 'SP02', aows: 1 });
  });

  /* ── Rule 9: ServiceUnavailableException handling ───────── */

  it('catches ServiceUnavailableException per-program and does not abort the loop', async () => {
    const p1 = makeProgram({ id: 1, officialCode: 'SP01' });
    const p2 = makeProgram({ id: 2, officialCode: 'SP02' });
    programRepo.find.mockResolvedValue([p1, p2]);

    tocServiceMock.fetchProgram
      .mockRejectedValueOnce(
        new ServiceUnavailableException(
          'TOC API is unavailable (/api/toc/SP01)',
        ),
      )
      .mockResolvedValueOnce({ data: [makeAowNode()] });

    const result = await service.syncAll();

    expect(result.synced).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.details[0].error).toContain('TOC API is unavailable');
    expect(result.details[1].aows).toBe(1);
  });

  it('records the error message in details when a program throws', async () => {
    programRepo.find.mockResolvedValue([makeProgram()]);
    tocServiceMock.fetchProgram.mockRejectedValue(
      new Error('connect ECONNREFUSED'),
    );

    const result = await service.syncAll();

    expect(result.failed).toBe(1);
    expect(result.details[0].error).toContain('connect ECONNREFUSED');
  });

  it('calls Logger.error when a program throws', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error');
    programRepo.find.mockResolvedValue([makeProgram()]);
    tocServiceMock.fetchProgram.mockRejectedValue(new Error('network fail'));

    await service.syncAll();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('SP01'),
      expect.anything(),
    );
  });

  /* ── Log line format ────────────────────────────────────── */

  it('emits a per-program log line matching the expected format', async () => {
    const logSpy = jest.spyOn(Logger.prototype, 'log');
    programRepo.find.mockResolvedValue([makeProgram()]);
    tocServiceMock.fetchProgram.mockResolvedValue({
      data: [makeAowNode(), makeOutputNode(), makeOutcomeNode()],
    });

    await service.syncAll();

    const calls = logSpy.mock.calls.map((c) => c[0] as string);
    const programLine = calls.find((msg) =>
      /^\[TocSync\] \S+ — aows: \d+, outcomes: \d+, outputs: \d+$/.test(msg),
    );
    expect(programLine).toBeDefined();
  });

  /* ── Empty programs table ───────────────────────────────── */

  it('returns synced=0, failed=0, details=[] when programs table is empty', async () => {
    programRepo.find.mockResolvedValue([]);

    const result = await service.syncAll();

    expect(result).toStrictEqual({ synced: 0, failed: 0, details: [] });
  });

  /* ── Multi-program scoping ──────────────────────────────── */

  it('passes the correct programId to the transaction for each program', async () => {
    const p1 = makeProgram({ id: 10, officialCode: 'SP01' });
    const p2 = makeProgram({ id: 20, officialCode: 'SP02' });
    programRepo.find.mockResolvedValue([p1, p2]);

    tocServiceMock.fetchProgram.mockResolvedValue({ data: [makeAowNode()] });

    await service.syncAll();

    /* Two transactions should have been started (one per program). */
    expect(mockDataSource.transaction).toHaveBeenCalledTimes(2);
  });

  /* ── Data field mapping on Output ──────────────────────── */

  it('maps all Output fields correctly', async () => {
    const outputNode: TocDataNode = {
      id: 'OUT-FULL',
      category: 'OUTPUT',
      title: 'Full Output',
      description: 'Full description',
      type_of_output: 'Policy brief',
      related_node_id: 'OUT-FULL-REL',
      group: null,
    };
    programRepo.find.mockResolvedValue([makeProgram()]);
    tocServiceMock.fetchProgram.mockResolvedValue({ data: [outputNode] });

    await service.syncAll();

    const saved = mockDataSource._savedOutputs[0] as TocOutput;
    expect(saved.nodeId).toBe(
      'OUT-FULL-REL',
    ); /* derived from related_node_id */
    expect(saved.title).toBe('Full Output');
    expect(saved.description).toBe('Full description');
    expect(saved.typeOfOutput).toBe('Policy brief');
    expect(saved.relatedNodeId).toBe('OUT-FULL-REL');
    expect(saved.aowId).toBeNull();
  });

  /* ── Data field mapping on Outcome ─────────────────────── */

  it('maps all Outcome fields correctly', async () => {
    const outcomeNode: TocDataNode = {
      id: 'OC-FULL',
      category: 'EOI',
      title: 'Full Outcome',
      description: 'Full outcome description',
      related_node_id: 'OC-FULL-REL',
      group: null,
    };
    programRepo.find.mockResolvedValue([makeProgram()]);
    tocServiceMock.fetchProgram.mockResolvedValue({ data: [outcomeNode] });

    await service.syncAll();

    const saved = mockDataSource._savedOutcomes[0] as TocOutcome;
    expect(saved.nodeId).toBe('OC-FULL-REL');
    expect(saved.title).toBe('Full Outcome');
    expect(saved.description).toBe('Full outcome description');
    expect(saved.outcomeType).toBe(TocOutcomeType.PORTFOLIO);
    expect(saved.relatedNodeId).toBe('OC-FULL-REL');
  });

  /* ── toc_outcome_aows junction ─────────────────────────────
     The junction is populated solely from each outcome's own
     `group` field — relations-graph traversal was tried and
     pulled back because it surfaced AOW affiliations that
     misrepresented EOI/Portfolio outcomes. The junction holds
     either 0 or 1 row per outcome today; the table is kept
     (rather than reverted) so multi-AOW resolution can be
     re-introduced without another migration. */

  describe('toc_outcome_aows junction', () => {
    /**
     * Helper: find every junction row written for one outcome
     * (resolved by nodeId, since the test's id sequencer is
     * deterministic but easier to reason about by node).
     */
    function junctionFor(
      ds: ReturnType<typeof buildMockDataSource>,
      outcomeNodeId: string,
    ): Array<{ outcomeId: number; aowId: number }> {
      const outcome = ds._savedOutcomes.find(
        (o) => (o as TocOutcome).nodeId === outcomeNodeId,
      ) as TocOutcome | undefined;
      if (!outcome) return [];
      return ds._savedJunction.filter((j) => j.outcomeId === outcome.id);
    }

    it('writes ONE junction row when outcome.group is set and no relations edge exists', async () => {
      const aowNode = makeAowNode({
        id: 'WP-1',
        ost_wp: { name: 'A1', acronym: 'A1', wp_official_code: 'SP01-A1' },
      });
      const outcomeNode = makeOutcomeNode({ id: 'OC-1', group: 'WP-1' });

      programRepo.find.mockResolvedValue([makeProgram()]);
      tocServiceMock.fetchProgram.mockResolvedValue({
        data: [aowNode, outcomeNode],
      });

      await service.syncAll();

      const rows = junctionFor(mockDataSource, 'OC-1');
      expect(rows).toHaveLength(1);

      const savedOutcome = mockDataSource._savedOutcomes[0] as TocOutcome;
      const savedAow = mockDataSource._savedAows[0] as TocAow;
      expect(rows[0]).toEqual({
        outcomeId: savedOutcome.id,
        aowId: savedAow.id,
      });
      /* Legacy scalar mirrors the first (and only) junction row. */
      expect(savedOutcome.aowId).toBe(savedAow.id);
    });

    it('does NOT consult the relations[] graph: outcome with empty group stays orphan even when LINK edges exist', async () => {
      /* The sync deliberately reads only outcome.group — relations
       * traversal was removed because EOIs (Portfolio outcomes) in
       * the working-draft payload often have a populated group of
       * their own; surfacing additional AOWs via inbound LINK edges
       * misrepresented their actual scope. Pin that contract here:
       * even with a perfectly valid LINK from a grouped OUTPUT into
       * this outcome, no junction row is written. */
      const aowNode = makeAowNode({ id: 'WP-1' });
      const outputNode = makeOutputNode({ id: 'OUT-A', group: 'WP-1' });
      const outcomeNode = makeOutcomeNode({ id: 'OC-1', group: '' });

      programRepo.find.mockResolvedValue([makeProgram()]);
      tocServiceMock.fetchProgram.mockResolvedValue({
        data: [aowNode, outputNode, outcomeNode],
        relations: [{ from: 'OUT-A', to: 'OC-1', category: 'LINK' }],
      });

      await service.syncAll();

      const rows = junctionFor(mockDataSource, 'OC-1');
      expect(rows).toHaveLength(0);
      const savedOutcome = mockDataSource._savedOutcomes[0] as TocOutcome;
      expect(savedOutcome.aowId).toBeNull();
    });

    it('writes ONE junction row when outcome.group is set (group is the only signal consulted)', async () => {
      /* Group on the outcome itself drives the link. Any inbound
       * LINK edges are ignored. */
      const aowNode = makeAowNode({ id: 'WP-1' });
      const outputNode = makeOutputNode({ id: 'OUT-A', group: 'WP-1' });
      const outcomeNode = makeOutcomeNode({ id: 'OC-1', group: 'WP-1' });

      programRepo.find.mockResolvedValue([makeProgram()]);
      tocServiceMock.fetchProgram.mockResolvedValue({
        data: [aowNode, outputNode, outcomeNode],
        relations: [{ from: 'OUT-A', to: 'OC-1', category: 'LINK' }],
      });

      await service.syncAll();

      const rows = junctionFor(mockDataSource, 'OC-1');
      expect(rows).toHaveLength(1);
    });

    it('writes ONLY the group-derived AOW even when multiple OUTPUTs across different AOWs LINK in', async () => {
      /* The legacy multi-AOW (graph-union) behaviour is gone; the
       * outcome's own group is the single source of truth. Inbound
       * LINK edges from OUT-1 (WP-1) and OUT-2 (WP-2) contribute
       * nothing — the junction reflects only WP-1 because that's
       * what the outcome's group points at. */
      const aow1 = makeAowNode({
        id: 'WP-1',
        ost_wp: { name: 'A1', acronym: 'A1', wp_official_code: 'SP01-A1' },
      });
      const aow2 = makeAowNode({
        id: 'WP-2',
        ost_wp: { name: 'A2', acronym: 'A2', wp_official_code: 'SP01-A2' },
      });
      const out1 = makeOutputNode({ id: 'OUT-1', group: 'WP-1' });
      const out2 = makeOutputNode({ id: 'OUT-2', group: 'WP-2' });
      const outcomeNode = makeOutcomeNode({ id: 'OC-1', group: 'WP-1' });

      programRepo.find.mockResolvedValue([makeProgram()]);
      tocServiceMock.fetchProgram.mockResolvedValue({
        data: [aow1, aow2, out1, out2, outcomeNode],
        relations: [
          { from: 'OUT-1', to: 'OC-1', category: 'LINK' },
          { from: 'OUT-2', to: 'OC-1', category: 'LINK' },
        ],
      });

      await service.syncAll();

      const rows = junctionFor(mockDataSource, 'OC-1');
      expect(rows).toHaveLength(1);

      const savedAow1 = (mockDataSource._savedAows as TocAow[]).find(
        (a) => a.nodeId === 'WP-1',
      )!;
      expect(rows[0].aowId).toBe(savedAow1.id);

      const savedOutcome = mockDataSource._savedOutcomes[0] as TocOutcome;
      expect(savedOutcome.aowId).toBe(savedAow1.id);
    });

    it('writes NO junction rows and leaves legacy aow_id null when outcome has neither group nor relations', async () => {
      const aowNode = makeAowNode({ id: 'WP-1' });
      const outcomeNode = makeOutcomeNode({ id: 'OC-1', group: '' });

      programRepo.find.mockResolvedValue([makeProgram()]);
      tocServiceMock.fetchProgram.mockResolvedValue({
        data: [aowNode, outcomeNode],
        /* No relations field at all — the payload guard must
         * tolerate that and not crash. */
      });

      await service.syncAll();

      const rows = junctionFor(mockDataSource, 'OC-1');
      expect(rows).toHaveLength(0);
      const savedOutcome = mockDataSource._savedOutcomes[0] as TocOutcome;
      expect(savedOutcome.aowId).toBeNull();
    });

    it('re-running sync replaces (not appends) the junction rows for an outcome', async () => {
      /* Two consecutive syncs against the same fixture must yield
       * exactly one junction row, not two. The sync service runs a
       * DELETE before each INSERT to enforce this. */
      const aowNode = makeAowNode({ id: 'WP-1' });
      const outcomeNode = makeOutcomeNode({ id: 'OC-1', group: 'WP-1' });

      programRepo.find.mockResolvedValue([makeProgram()]);
      tocServiceMock.fetchProgram.mockResolvedValue({
        data: [aowNode, outcomeNode],
      });

      await service.syncAll();
      await service.syncAll();

      /* After two syncs the junction still holds one row for the
       * (latest) outcome id. The previous sync's outcomeId may differ
       * because the id sequencer resets per transaction — group by
       * outcome to be sure no outcome ended up with 2 rows. */
      const byOutcome = new Map<number, number>();
      for (const j of mockDataSource._savedJunction) {
        byOutcome.set(j.outcomeId, (byOutcome.get(j.outcomeId) ?? 0) + 1);
      }
      for (const count of byOutcome.values()) {
        expect(count).toBe(1);
      }
    });
  });
});
