/**
 * BaseService — minimal implementation for scaffold validation.
 *
 * Provides the service layer that generated services inherit.
 * Delegates all operations to the repository.
 */
import type { BaseRepository } from './base-repository';

export abstract class BaseService<
  TRepository extends BaseRepository<TEntity>,
  TEntity extends { id: string },
> {
  protected abstract readonly repository: TRepository;

  async findById(id: string): Promise<TEntity | null> {
    return this.repository.findById(id);
  }

  async findByIds(ids: string[]): Promise<TEntity[]> {
    return this.repository.findByIds(ids);
  }

  async list(): Promise<TEntity[]> {
    return this.repository.list();
  }

  async count(): Promise<number> {
    return this.repository.count();
  }

  async exists(id: string): Promise<boolean> {
    return this.repository.exists(id);
  }

  async create(data: Omit<TEntity, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt'>): Promise<TEntity> {
    return this.repository.create(data);
  }

  async update(id: string, data: Partial<TEntity>): Promise<TEntity | null> {
    return this.repository.update(id, data);
  }

  async delete(id: string): Promise<TEntity | null> {
    return this.repository.delete(id);
  }
}
