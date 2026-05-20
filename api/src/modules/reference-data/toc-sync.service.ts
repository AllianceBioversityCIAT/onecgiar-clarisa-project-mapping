import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { TocService } from '../toc/toc.service';
import { TocDataNode } from '../toc/interfaces';
import { Program } from './entities/program.entity';
import { TocAow } from './entities/toc-aow.entity';
import { TocOutcome, TocOutcomeType } from './entities/toc-outcome.entity';
import { TocOutput } from './entities/toc-output.entity';
import {
  TocSyncProgramDetail,
  TocSyncResultDto,
} from './dto/toc-sync-result.dto';

/**
 * Service that fans out the TOC sync across every program in the
 * local database, upserts the resulting AOW / Outcome / Output rows,
 * and returns a per-program summary.
 *
 * The sync is admin-triggered (`POST /admin/sync-toc`) and also
 * auto-runs on startup when all three TOC tables are empty —
 * wiring for the bootstrap path lives in {@link
 * ReferenceDataService.onApplicationBootstrap}, not here, so the
 * service stays cleanly testable in isolation.
 */
@Injectable()
export class TocSyncService {
  private readonly logger = new Logger(TocSyncService.name);

  constructor(
    @InjectRepository(Program)
    private readonly programRepo: Repository<Program>,
    @InjectRepository(TocAow)
    private readonly aowRepo: Repository<TocAow>,
    @InjectRepository(TocOutcome)
    private readonly outcomeRepo: Repository<TocOutcome>,
    @InjectRepository(TocOutput)
    private readonly outputRepo: Repository<TocOutput>,
    private readonly tocService: TocService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Run a full TOC sync across every program in the `programs` table.
   *
   * Per program: fetch the graph; on 404 record `error: 'not_found'`
   * and continue; on success run a transactional upsert of AOWs first
   * (so Outputs and Outcomes can resolve their `aow_id` FK), then
   * Outputs and Outcomes.
   */
  async syncAll(): Promise<TocSyncResultDto> {
    const programs = await this.programRepo.find({ order: { id: 'ASC' } });
    this.logger.log(
      `[TocSync] Starting sync across ${programs.length} programs`,
    );

    const details: TocSyncProgramDetail[] = [];
    let synced = 0;
    let failed = 0;

    for (const program of programs) {
      const code = program.officialCode;
      try {
        const response = await this.tocService.fetchProgram(code);
        if (response === null) {
          /* 404 path — TocService already logged a warning. */
          details.push({ programCode: code, error: 'not_found' });
          failed++;
          continue;
        }

        const counts = await this.syncProgram(program.id, response.data ?? []);
        details.push({ programCode: code, ...counts });
        synced++;
        this.logger.log(
          `[TocSync] ${code} — aows: ${counts.aows}, outcomes: ${counts.outcomes}, outputs: ${counts.outputs}`,
        );
      } catch (error) {
        /* A genuine network/5xx error from TocService is a hard fail —
         * swallow it for this program so the rest of the loop runs, and
         * report it in the per-program detail. */
        const message = (error as Error).message ?? 'unknown_error';
        this.logger.error(
          `[TocSync] ${code} failed: ${message}`,
          (error as Error).stack,
        );
        details.push({ programCode: code, error: message });
        failed++;
      }
    }

    this.logger.log(
      `[TocSync] Complete — synced: ${synced}, failed: ${failed}`,
    );
    return { synced, failed, details };
  }

  /**
   * Upsert one program's worth of TOC graph rows inside a single
   * transaction. Returns the per-entity upsert counts.
   *
   * Order matters: AOWs first (so we have ids to resolve `aow_id`
   * on Outputs and Outcomes via the WP.id → aowId map), then
   * Outputs and Outcomes.
   */
  private async syncProgram(
    programId: number,
    nodes: TocDataNode[],
  ): Promise<{ aows: number; outcomes: number; outputs: number }> {
    const syncedAt = new Date();

    return this.dataSource.transaction(async (manager) => {
      const aowRepo = manager.getRepository(TocAow);
      const outcomeRepo = manager.getRepository(TocOutcome);
      const outputRepo = manager.getRepository(TocOutput);

      /* ── 1. AOWs ──────────────────────────────────────────────── */
      const aowNodes = nodes.filter(
        (n) => n.category === 'WP' && n.wp_type === 'AOW',
      );

      /* Map raw WP.id → aowId, used to resolve OUTPUT.group / OUTCOME.group
       * back to a foreign key. We key by `n.id` (NOT the derived nodeId)
       * because outputs/outcomes reference the raw graph id, per spec. */
      const wpIdToAowId = new Map<string, number>();

      for (const node of aowNodes) {
        const nodeId = this.resolveNodeId(node);
        if (!nodeId) continue; /* defensive — should never happen */

        let row = await aowRepo.findOne({
          where: { programId, nodeId },
        });
        if (!row) {
          row = aowRepo.create({ programId, nodeId });
        }
        row.clarisaTocId = node.ost_wp?.toc_id ?? null;
        row.acronym = node.ost_wp?.acronym ?? null;
        row.wpOfficialCode = node.ost_wp?.wp_official_code ?? null;
        /* name: prefer ost_wp.name, fall back to the (often empty) title,
         * then to empty string so the column stays predictable. */
        row.name = node.ost_wp?.name ?? node.title ?? '';
        row.syncedAt = syncedAt;

        const saved = await aowRepo.save(row);
        wpIdToAowId.set(node.id, saved.id);
      }

      /* ── 2. Outputs ───────────────────────────────────────────── */
      const outputNodes = nodes.filter((n) => n.category === 'OUTPUT');
      for (const node of outputNodes) {
        const nodeId = this.resolveNodeId(node);
        if (!nodeId) continue;

        let row = await outputRepo.findOne({
          where: { programId, nodeId },
        });
        if (!row) {
          row = outputRepo.create({ programId, nodeId });
        }
        row.title = node.title ?? null;
        row.description = node.description ?? null;
        row.typeOfOutput = node.type_of_output ?? null;
        row.relatedNodeId = node.related_node_id ?? null;
        row.aowId = this.resolveAowId(node.group, wpIdToAowId);
        row.syncedAt = syncedAt;
        await outputRepo.save(row);
      }

      /* ── 3. Outcomes (OUTCOME + EOI) ──────────────────────────── */
      const outcomeNodes = nodes.filter(
        (n) => n.category === 'OUTCOME' || n.category === 'EOI',
      );
      for (const node of outcomeNodes) {
        const nodeId = this.resolveNodeId(node);
        if (!nodeId) continue;

        let row = await outcomeRepo.findOne({
          where: { programId, nodeId },
        });
        if (!row) {
          row = outcomeRepo.create({ programId, nodeId });
        }
        row.title = node.title ?? null;
        row.description = node.description ?? null;
        row.outcomeType =
          node.category === 'EOI'
            ? TocOutcomeType.PORTFOLIO
            : TocOutcomeType.INTERMEDIATE;
        row.relatedNodeId = node.related_node_id ?? null;
        row.aowId = this.resolveAowId(node.group, wpIdToAowId);
        row.syncedAt = syncedAt;
        await outcomeRepo.save(row);
      }

      return {
        aows: aowNodes.length,
        outcomes: outcomeNodes.length,
        outputs: outputNodes.length,
      };
    });
  }

  /**
   * Compute the row-level `node_id` for any TOC graph node.
   *
   * Rule (user-confirmed): `related_node_id` if truthy, else `id`.
   * Returns null only if both are missing — which shouldn't happen
   * in well-formed TOC data, but we guard rather than crash.
   */
  private resolveNodeId(node: TocDataNode): string | null {
    if (node.related_node_id && node.related_node_id.trim() !== '') {
      return node.related_node_id;
    }
    if (node.id && node.id.trim() !== '') {
      return node.id;
    }
    return null;
  }

  /**
   * Resolve the `group` field on an Output / Outcome row to an `aow_id`
   * FK by looking it up in the WP.id → aowId map built in step 1.
   *
   * Empty string and null both collapse to a null FK (the column is
   * nullable, so we don't lose the row over a missing parent).
   */
  private resolveAowId(
    group: string | null | undefined,
    wpIdToAowId: Map<string, number>,
  ): number | null {
    if (!group || group.trim() === '') return null;
    return wpIdToAowId.get(group) ?? null;
  }
}
