import { User } from './types.js';
import { getSecret } from './secrets.js';
import mysql from 'mysql2/promise';

interface DbSecret {
    host: string;
    port: number;
    username: string;
    password: string;
    dbname: string;
}

let pool: mysql.Pool | null = null;

async function getPool(): Promise<mysql.Pool> {
    if (pool) return pool;
    const secret = await getSecret<DbSecret>('db');
    pool = mysql.createPool({
        host: secret.host,
        database: secret.dbname,
        user: secret.username,
        password: secret.password,
        port: secret.port,
        connectTimeout: 30000,
        connectionLimit: 1,
        maxIdle: 0,
        waitForConnections: true,
        queueLimit: 0,
    });
    return pool;
}

export async function executeSQLQuery(query: string, params: any[] = []): Promise<any> {
    const p = await getPool();
    let connection;
    try {
        connection = await p.getConnection();
        const [results] = await connection.query(query, params);
        return results;
    } catch (error) {
        console.error(`Database query error (${(error as any)?.code ?? 'UNKNOWN'}): ${(error as any)?.message ?? error}`);
        throw error;
    } finally {
        if (connection) connection.release();
    }
}

export async function getUserDetails(userId: number): Promise<User | null> {
    const query = `SELECT UserFirstName, UserLastName, SlackID, UserEmail FROM Users WHERE UserID = ?`;
    const result = await executeSQLQuery(query, [userId]);
    if (result.length > 0) {
        return {
            userId,
            fullName: `${result[0].UserFirstName} ${result[0].UserLastName}`,
            firstName: result[0].UserFirstName,
            lastName: result[0].UserLastName,
            slackID: result[0].SlackID,
            email: result[0].UserEmail,
        };
    }
    return null;
}
