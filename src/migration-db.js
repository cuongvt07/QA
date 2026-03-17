const db = require('./db');

async function migrate() {
    console.log('🚀 Starting Database Migration...');

    try {
        // 1. Add batch_id to test_run
        console.log('[1/3] Adding batch_id to test_run...');
        const columns = await db.query("SHOW COLUMNS FROM test_run LIKE 'batch_id'");
        if (columns.length === 0) {
            await db.query(`
                ALTER TABLE test_run 
                ADD COLUMN batch_id VARCHAR(50) DEFAULT NULL AFTER test_case_id
            `);
            console.log('    - batch_id column added.');
        } else {
            console.log('    - batch_id column already exists.');
        }

        // 2. Add performance indexes
        console.log('[2/3] Adding performance indexes...');
        const addIndex = async (table, indexName, columns) => {
            try {
                // Check if index exists
                const indexes = await db.query(`SHOW INDEX FROM ${table} WHERE Key_name = ?`, [indexName]);
                if (indexes.length === 0) {
                    await db.query(`CREATE INDEX ${indexName} ON ${table} (${columns})`);
                    console.log(`    - Index ${indexName} added to ${table}`);
                } else {
                    console.log(`    - Index ${indexName} already exists on ${table}`);
                }
            } catch (e) {
                console.error(`    - Error processing index ${indexName}:`, e.message);
            }
        };

        await addIndex('test_run', 'idx_test_case_status', 'test_case_id, status');
        await addIndex('test_run', 'idx_created_at', 'created_at');
        await addIndex('test_run', 'idx_batch_id', 'batch_id');
        await addIndex('test_case', 'idx_status', 'status');

        // 3. Optimize status columns
        console.log('[3/3] Optimizing status columns...');
        try {
            // First, migrate test_run status values to uppercase
            await db.query("UPDATE test_run SET status = 'FAILED' WHERE status NOT IN ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'FATAL')");
            await db.query("UPDATE test_run SET status = UPPER(status)");
            
            await db.query(`
                ALTER TABLE test_run 
                MODIFY COLUMN status ENUM('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'FATAL') NOT NULL
            `);
            console.log('    - test_run.status converted to ENUM (Uppercase)');

            // Second, migrate test_case status values
            // Existing: ('pending', 'running', 'pass', 'fail')
            // Target: ('PENDING', 'QUEUED', 'RUNNING', 'PASS', 'FAIL')
            
            // Normalize existing to uppercase
            await db.query("UPDATE test_case SET status = 'PENDING' WHERE status NOT IN ('pending', 'running', 'pass', 'fail', 'PENDING', 'QUEUED', 'RUNNING', 'PASS', 'FAIL')");
            await db.query("UPDATE test_case SET status = UPPER(status)");
            
            await db.query(`
                ALTER TABLE test_case 
                MODIFY COLUMN status ENUM('PENDING', 'QUEUED', 'RUNNING', 'PASS', 'FAIL') NOT NULL DEFAULT 'PENDING'
            `);
            console.log('    - test_case.status converted to ENUM (Uppercase)');

        } catch (e) {
            console.error('    - Error optimizing status columns:', e.message);
        }

        console.log('\n✅ Database migration completed successfully.');
        process.exit(0);
    } catch (error) {
        console.error('\n❌ Migration failed:', error.message);
        process.exit(1);
    }
}

migrate();
