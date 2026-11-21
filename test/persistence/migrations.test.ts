import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import ormConfig from '../../src/infrastructure/persistence/mikro-orm.config';

const DB_NAME = `wagering_migrations_${process.pid}`;

const tables = async (orm: MikroORM): Promise<string[]> => {
  const rows = (await orm.em
    .getConnection()
    .execute(
      `select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
    )) as { table_name: string }[];
  return rows.map((row) => row.table_name);
};

describe('migrations', () => {
  let admin: MikroORM;
  let orm: MikroORM;

  beforeAll(async () => {
    admin = await MikroORM.init(ormConfig);
    await admin.em.getConnection().execute(`create database "${DB_NAME}"`);
    orm = await MikroORM.init({ ...ormConfig, dbName: DB_NAME });
  });

  afterAll(async () => {
    await orm.close();
    await admin.em.getConnection().execute(`drop database if exists "${DB_NAME}"`);
    await admin.close();
  });

  test('are reversible: up, down to zero, and up again leave the schema in sync', async () => {
    await orm.migrator.up();
    const migrated = await tables(orm);
    expect(migrated).toEqual(
      expect.arrayContaining([
        'inbox_message',
        'outbox_message',
        'wager_transaction',
        'wallet',
        'wallet_ledger_entry',
      ]),
    );

    await orm.migrator.down({ to: 0 });
    expect(await tables(orm)).toEqual(['mikro_orm_migrations']);
    expect(await orm.migrator.getExecuted()).toEqual([]);

    await orm.migrator.up();
    expect(await tables(orm)).toEqual(migrated);
    expect(await orm.migrator.checkSchema()).toBe(false);
  });
});
