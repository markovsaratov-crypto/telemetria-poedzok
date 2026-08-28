// src/lib/user-db.ts — User table access via libsql directly (no db.ts changes needed).
import { libsql } from "./db";
import { randomUUID } from "crypto";

export interface UserRow {
  id: string;
  email: string;
  passwordHash: string;
  role: string;
  apiKey: string;
  createdAt: string;
  updatedAt: string;
}

function rowToUser(row: Record<string, unknown>): UserRow {
  return {
    id: String(row.id),
    email: String(row.email),
    passwordHash: String(row.passwordHash),
    role: String(row.role),
    apiKey: String(row.apiKey),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

export const userDb = {
  async findByEmail(email: string): Promise<UserRow | null> {
    const res = await libsql.execute({
      sql: "SELECT * FROM User WHERE email = ? LIMIT 1",
      args: [email.toLowerCase()],
    });
    if (res.rows.length === 0) return null;
    return rowToUser(res.rows[0] as Record<string, unknown>);
  },

  async findById(id: string): Promise<UserRow | null> {
    const res = await libsql.execute({
      sql: "SELECT * FROM User WHERE id = ? LIMIT 1",
      args: [id],
    });
    if (res.rows.length === 0) return null;
    return rowToUser(res.rows[0] as Record<string, unknown>);
  },

  async findByApiKey(apiKey: string): Promise<UserRow | null> {
    const res = await libsql.execute({
      sql: "SELECT * FROM User WHERE apiKey = ? LIMIT 1",
      args: [apiKey],
    });
    if (res.rows.length === 0) return null;
    return rowToUser(res.rows[0] as Record<string, unknown>);
  },

  async count(): Promise<number> {
    const res = await libsql.execute("SELECT COUNT(*) as count FROM User");
    return Number((res.rows[0] as Record<string, unknown>).count);
  },

  async create(input: {
    email: string;
    passwordHash: string;
    role?: string;
  }): Promise<UserRow> {
    const id = randomUUID();
    const apiKey = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
    const now = new Date().toISOString();
    const role = input.role ?? "user";
    await libsql.execute({
      sql: `INSERT INTO User (id, email, passwordHash, role, apiKey, createdAt, updatedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [id, input.email.toLowerCase(), input.passwordHash, role, apiKey, now, now],
    });
    return {
      id,
      email: input.email.toLowerCase(),
      passwordHash: input.passwordHash,
      role,
      apiKey,
      createdAt: now,
      updatedAt: now,
    };
  },
};
