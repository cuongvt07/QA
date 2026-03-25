const db = require('./db');
const bcrypt = require('bcryptjs');

async function migrate() {
    console.log('🚀 Starting Auth Database Migration...');

    try {
        // 1. Create users table
        console.log('[1/2] Creating users table...');
        await db.query(`
            CREATE TABLE IF NOT EXISTS users (
                id VARCHAR(50) PRIMARY KEY,
                email VARCHAR(255) NOT NULL UNIQUE,
                password VARCHAR(255) NOT NULL,
                role ENUM('ADMIN', 'USER') NOT NULL DEFAULT 'USER',
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
        `);
        console.log('    - users table created or already exists.');

        // 2. Seed default admin account
        console.log('[2/2] Seeding default admin account...');
        const adminEmail = 'admin@megaads.com';
        const adminPasswordRaw = '123456';
        
        const existing = await db.query('SELECT id FROM users WHERE email = ?', [adminEmail]);
        
        if (existing.length === 0) {
            const hashedPassword = await bcrypt.hash(adminPasswordRaw, 10);
            const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
            const adminId = `USER_${Date.now()}`;
            
            await db.query(
                'INSERT INTO users (id, email, password, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
                [adminId, adminEmail, hashedPassword, 'ADMIN', now, now]
            );
            console.log(`    - Default admin account created: ${adminEmail} / ${adminPasswordRaw}`);
        } else {
            console.log('    - Admin account already exists.');
        }

        console.log('\n✅ Auth database migration completed successfully.');
        process.exit(0);
    } catch (error) {
        console.error('\n❌ Migration failed:', error.message);
        process.exit(1);
    }
}

migrate();
