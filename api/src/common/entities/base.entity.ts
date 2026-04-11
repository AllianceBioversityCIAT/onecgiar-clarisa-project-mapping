import {
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Abstract base entity providing common columns for all database tables.
 *
 * Every entity in the application should extend this class to inherit
 * an auto-increment integer primary key, automatic creation timestamp,
 * and automatic update timestamp.
 */
export abstract class BaseEntity {
  /** Auto-increment integer primary key. */
  @PrimaryGeneratedColumn('increment')
  id: number;

  /** Timestamp set automatically when the row is first inserted. */
  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  /** Timestamp updated automatically on every row modification. */
  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
