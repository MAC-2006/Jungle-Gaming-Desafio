import { Migrator } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import path from 'node:path';
import type { AppConfig } from '../../config/config';

/**
 * MikroORM é usado para: pool de conexões, gerenciamento de transações (EntityManager.transactional)
 * e migrations versionadas e reversíveis. As instruções críticas (INSERT ... ON CONFLICT,
 * SELECT ... FOR UPDATE [SKIP LOCKED], UPDATE com checagem de versão) são SQL explícito executado
 * DENTRO da transação do EntityManager (em.execute) — ver docs/ARCHITECTURE.md, "Por que SQL explícito".
 */
export async function createOrm(config: Pick<AppConfig, 'DATABASE_URL' | 'DB_POOL_MAX'>): Promise<MikroORM> {
  return MikroORM.init({
    clientUrl: config.DATABASE_URL,
    entities: [],
    discovery: { warnWhenNoEntities: false, requireEntitiesArray: false },
    extensions: [Migrator],
    pool: { min: 1, max: config.DB_POOL_MAX },
    migrations: {
      path: path.resolve(import.meta.dir, 'migrations'),
      pathTs: path.resolve(import.meta.dir, 'migrations'),
      glob: '!(*.d).{js,ts}',
      tableName: 'schema_migrations',
      transactional: true,
      allOrNothing: true,
      snapshot: false,
    },
    allowGlobalContext: true,
    logger: () => undefined,
  });
}
