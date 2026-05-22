import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { Country } from '../../reference-data/entities/country.entity';
import { Project } from './project.entity';

/**
 * Junction row between `projects` and `countries` for the Location of
 * Benefit list, carrying an `allocation_percentage` decimal(5,2).
 *
 * The service layer enforces:
 *  - each row's allocation_percentage > 0 (zero rows are not allowed);
 *  - SUM(allocation_percentage) per project ≤ 100;
 *  - when the parent project's `isBenefitGlobal` flag is true, no rows
 *    may exist (the global flag and per-country allocations are
 *    mutually exclusive).
 */
@Entity('project_countries')
export class ProjectBenefitCountry {
  @PrimaryColumn({ name: 'project_id', type: 'int' })
  projectId: number;

  @PrimaryColumn({ name: 'country_id', type: 'int' })
  countryId: number;

  /** Share of the project's beneficiary scope attributed to this country. */
  @Column({
    name: 'allocation_percentage',
    type: 'decimal',
    precision: 5,
    scale: 2,
  })
  allocationPercentage: number;

  @ManyToOne(() => Project, (p) => p.benefitCountries, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'project_id' })
  project: Project;

  @ManyToOne(() => Country, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    eager: true,
  })
  @JoinColumn({ name: 'country_id' })
  country: Country;
}
