import { loadConfig } from '../../config/config';
import { createOrm } from './orm';

const command = process.argv[2] ?? 'up';
const config = loadConfig();
const orm = await createOrm(config);
try {
  const migrator = orm.getMigrator();
  if (command === 'up') {
    const done = await migrator.up();
    console.log(`applied: ${done.map((m) => m.name).join(', ') || '(nothing to apply)'}`);
  } else if (command === 'down') {
    const done = await migrator.down();
    console.log(`reverted: ${done.map((m) => m.name).join(', ') || '(nothing to revert)'}`);
  } else if (command === 'status') {
    console.log('executed:', (await migrator.getExecutedMigrations()).map((m) => m.name));
    console.log('pending:', (await migrator.getPendingMigrations()).map((m) => m.name));
  } else {
    throw new Error(`unknown command "${command}" (use up | down | status)`);
  }
} finally {
  await orm.close();
}
