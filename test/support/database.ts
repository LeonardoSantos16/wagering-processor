import { expect } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import ormConfig from '../../src/infrastructure/persistence/mikro-orm.config';

export async function createTestOrm(): Promise<MikroORM> {
  const orm = await MikroORM.init(ormConfig);
  await orm.migrator.up();
  return orm;
}

export function rawSql(orm: MikroORM, sql: string, params: unknown[] = []): Promise<unknown> {
  return orm.em.getConnection().execute(sql, params);
}

export async function expectViolation(statement: Promise<unknown>, name: string): Promise<void> {
  const error = await statement.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain(name);
}

export function insertRow(orm: MikroORM, table: string, row: Record<string, unknown>): Promise<unknown> {
  const columns = Object.keys(row);
  const placeholders = columns.map(() => '?').join(', ');
  return rawSql(
    orm,
    `insert into ${table} (${columns.join(', ')}) values (${placeholders})`,
    Object.values(row),
  );
}

export interface TemporaryDatabase {
  orm: MikroORM;
  drop(): Promise<void>;
}

export async function createTemporaryDatabase(prefix: string): Promise<TemporaryDatabase> {
  const dbName = `${prefix}_${process.pid}_${Date.now()}`;
  const admin = await MikroORM.init(ormConfig);
  await admin.em.getConnection().execute(`create database "${dbName}"`);
  const orm = await MikroORM.init({ ...ormConfig, dbName });
  await orm.migrator.up();
  return {
    orm,
    drop: async () => {
      await orm.close();
      await admin.em.getConnection().execute(`drop database if exists "${dbName}"`);
      await admin.close();
    },
  };
}
