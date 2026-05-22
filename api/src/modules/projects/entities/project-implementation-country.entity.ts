import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { Country } from '../../reference-data/entities/country.entity';
import { Project } from './project.entity';

/**
 * Junction row between `projects` and `countries` for the Country of
 * Implementation list, carrying an `allocation_percentage`
 * decimal(5,2). Independent of the Location of Benefit list.
 *
 * Invariants enforced by the service layer mirror
 * `ProjectBenefitCountry`: each row > 0, sum ≤ 100, and the parent
 * project's `isImplementationGlobal` flag is mutually exclusive with
 * any rows.
 */
@Entity('project_implementation_countries')
export class ProjectImplementationCountry {
  @PrimaryColumn({ name: 'project_id', type: 'int' })
  projectId: number;

  @PrimaryColumn({ name: 'country_id', type: 'int' })
  countryId: number;

  /** Share of the project's implementation scope attributed to this country. */
  @Column({
    name: 'allocation_percentage',
    type: 'decimal',
    precision: 5,
    scale: 2,
  })
  allocationPercentage: number;

  @ManyToOne(() => Project, (p) => p.implementationCountries, {
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
