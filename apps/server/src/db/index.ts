import postgres from 'postgres';

export type Sql = postgres.Sql;
export type Tx = postgres.TransactionSql;
export type Fragment = postgres.Fragment;

export function createDb(url: string): Sql {
  return postgres(url, { max: 10, onnotice: () => {} });
}
