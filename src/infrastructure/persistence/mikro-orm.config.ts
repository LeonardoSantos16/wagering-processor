import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { loadConfig } from '../config/app-config';
import { WalletLedgerEntryRecord } from './ledger/wallet-ledger-entry.entity';
import { WagerTransactionRecord } from './wager-transaction/wager-transaction.entity';
import { WalletRecord } from './wallet/wallet.entity';

const { db } = loadConfig();

export default defineConfig({
  host: db.host,
  port: db.port,
  user: db.user,
  password: db.password,
  dbName: db.name,
  entities: [WalletRecord, WagerTransactionRecord, WalletLedgerEntryRecord],
  extensions: [Migrator],
  migrations: {
    path: 'src/infrastructure/persistence/migrations',
    glob: '!(*.d).ts',
    transactional: true,
    snapshotOnMigrate: false,
  },
});
