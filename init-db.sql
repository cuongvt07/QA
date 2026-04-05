-- =============================================================
-- Schema initialization for Custom Product QA Engine
-- =============================================================

CREATE TABLE IF NOT EXISTS test_case (
    id VARCHAR(50) PRIMARY KEY,
    name VARCHAR(100),
    url TEXT NOT NULL,
    status ENUM('PENDING', 'QUEUED', 'RUNNING', 'PASS', 'FAIL', 'FATAL', 'REVIEW') NOT NULL DEFAULT 'PENDING',
    last_run_id VARCHAR(50) DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS test_run (
    id VARCHAR(50) PRIMARY KEY,
    test_case_id VARCHAR(50),
    batch_id VARCHAR(50) DEFAULT NULL,
    name VARCHAR(100),
    url TEXT,
    tc_code VARCHAR(50),
    report_code VARCHAR(50),
    status ENUM('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'FATAL') NOT NULL,
    exit_code INT DEFAULT NULL,
    output LONGTEXT,
    source VARCHAR(50),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    started_at DATETIME,
    finished_at DATETIME,
    INDEX idx_test_case_status (test_case_id, status),
    INDEX idx_created_at (created_at),
    INDEX idx_batch_id (batch_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS test_report (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    test_run_id VARCHAR(50) NOT NULL UNIQUE,
    content LONGTEXT,
    score DECIMAL(5,2) DEFAULT 0,
    total_steps INT DEFAULT 0,
    passed_steps INT DEFAULT 0,
    failed_steps INT DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

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
