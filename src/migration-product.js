const db = require('./db');

async function migrate() {
    console.log('🚀 Starting Products Table Migration...');

    try {
        console.log('[1/1] Creating products table...');
        await db.query(`
            CREATE TABLE IF NOT EXISTS products (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                product_id VARCHAR(50) NOT NULL,
                platform VARCHAR(50) NOT NULL,
                redirect_url TEXT,
                final_url TEXT,
                customizable TINYINT(1) DEFAULT 0,
                note TEXT,
                status_code INT,
                has_error TINYINT(1) DEFAULT 0,
                checked_at DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uk_product_platform (product_id, platform)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
        `);
        console.log('    - products table created or already exists.');

        console.log('\n✅ Products migration completed successfully.');
        process.exit(0);
    } catch (error) {
        console.error('\n❌ Migration failed:', error.message);
        process.exit(1);
    }
}

migrate();
