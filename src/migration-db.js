const db = require('./db');

async function migrate() {
    console.log('🚀 Starting Database Migration...');

    try {
        // 1. Add batch_id to test_run
        console.log('[1/5] Adding batch_id to test_run...');
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
            // Target: ('PENDING', 'QUEUED', 'RUNNING', 'PASS', 'FAIL', 'FATAL', 'REVIEW')
            
            // Normalize existing to uppercase
            await db.query("UPDATE test_case SET status = 'PENDING' WHERE status NOT IN ('pending', 'running', 'pass', 'fail', 'PENDING', 'QUEUED', 'RUNNING', 'PASS', 'FAIL', 'FATAL', 'REVIEW')");
            await db.query("UPDATE test_case SET status = UPPER(status)");
            
            await db.query(`
                ALTER TABLE test_case 
                MODIFY COLUMN status ENUM('PENDING', 'QUEUED', 'RUNNING', 'PASS', 'FAIL', 'FATAL', 'REVIEW') NOT NULL DEFAULT 'PENDING'
            `);
            console.log('    - test_case.status converted to ENUM (Uppercase + Fatal/Review)');

        } catch (e) {
            console.error('    - Error optimizing status columns:', e.message);
        }

        // 4. Add last_run_id to test_case
        console.log('[4/5] Adding last_run_id to test_case...');
        try {
            const tcColumns = await db.query("SHOW COLUMNS FROM test_case LIKE 'last_run_id'");
            if (tcColumns.length === 0) {
                await db.query(`
                    ALTER TABLE test_case 
                    ADD COLUMN last_run_id VARCHAR(50) DEFAULT NULL AFTER status
                `);
                console.log('    - last_run_id column added (VARCHAR).');
            } else {
                // Check if it's INT and needs conversion
                const type = tcColumns[0].Type;
                if (type.toLowerCase().includes('int')) {
                    await db.query(`
                        ALTER TABLE test_case 
                        MODIFY COLUMN last_run_id VARCHAR(50) DEFAULT NULL
                    `);
                    console.log('    - last_run_id column converted from INT to VARCHAR(50).');
                } else {
                    console.log('    - last_run_id already exists and is not INT.');
                }
            }
        } catch (e) {
            console.error('    - Error adding/modifying last_run_id:', e.message);
        }

        // 5. Add exit_code to test_run
        console.log('[5/5] Adding exit_code to test_run...');
        try {
            const exitCodeColumns = await db.query("SHOW COLUMNS FROM test_run LIKE 'exit_code'");
            if (exitCodeColumns.length === 0) {
                await db.query(`
                    ALTER TABLE test_run 
                    ADD COLUMN exit_code INT DEFAULT NULL AFTER status
                `);
                console.log('    - exit_code column added.');
            } else {
                console.log('    - exit_code column already exists.');
            }
        } catch (e) {
            console.error('    - Error adding exit_code:', e.message);
        }

        // 6. Ensure test_run.output is LONGTEXT (prevents "Data too long" errors)
        console.log('[6/6] Ensuring test_run.output is LONGTEXT...');
        try {
            const outputCol = await db.query("SHOW COLUMNS FROM test_run LIKE 'output'");
            if (outputCol.length > 0) {
                const colType = outputCol[0].Type.toLowerCase();
                if (colType !== 'longtext') {
                    await db.query('ALTER TABLE test_run MODIFY COLUMN output LONGTEXT');
                    console.log(`    - test_run.output upgraded from ${colType} to LONGTEXT.`);
                } else {
                    console.log('    - test_run.output is already LONGTEXT.');
                }
            }
        } catch (e) {
            console.error('    - Error modifying output column:', e.message);
        }

        console.log('\n✅ Database migration completed successfully.');
        process.exit(0);
    } catch (error) {
        console.error('\n❌ Migration failed:', error.message);
        process.exit(1);
    }
}

migrate();
