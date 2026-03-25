CREATE TABLE roles (
  id BIGINT PRIMARY KEY,
  role_code VARCHAR(50) UNIQUE NOT NULL,
  role_name VARCHAR(100) NOT NULL
);

CREATE TABLE users (
  id BIGINT PRIMARY KEY,
  employee_code VARCHAR(50) UNIQUE NOT NULL,
  full_name VARCHAR(150) NOT NULL,
  role_id BIGINT NOT NULL,
  pin_code VARCHAR(20),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_users_role FOREIGN KEY (role_id) REFERENCES roles(id)
);

CREATE TABLE jobs (
  id BIGINT PRIMARY KEY,
  job_no VARCHAR(100) UNIQUE NOT NULL,
  job_name VARCHAR(255) NOT NULL,
  customer_name VARCHAR(255),
  description TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE work_orders (
  id BIGINT PRIMARY KEY,
  work_order_no VARCHAR(100) UNIQUE NOT NULL,
  job_id BIGINT NOT NULL,
  description TEXT,
  planned_qty DECIMAL(18,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_work_orders_job FOREIGN KEY (job_id) REFERENCES jobs(id)
);

CREATE TABLE parts (
  id BIGINT PRIMARY KEY,
  part_no VARCHAR(100) UNIQUE NOT NULL,
  part_name VARCHAR(255) NOT NULL,
  unit VARCHAR(50) NOT NULL DEFAULT 'PCS',
  min_stock DECIMAL(18,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE boxes (
  id BIGINT PRIMARY KEY,
  box_code VARCHAR(100) UNIQUE NOT NULL,
  job_id BIGINT,
  work_order_id BIGINT,
  description TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_boxes_job FOREIGN KEY (job_id) REFERENCES jobs(id),
  CONSTRAINT fk_boxes_work_order FOREIGN KEY (work_order_id) REFERENCES work_orders(id)
);

CREATE TABLE qr_codes (
  id BIGINT PRIMARY KEY,
  qr_value VARCHAR(255) UNIQUE NOT NULL,
  entity_type VARCHAR(30) NOT NULL,
  entity_id BIGINT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE locations (
  id BIGINT PRIMARY KEY,
  location_code VARCHAR(50) UNIQUE NOT NULL,
  location_name VARCHAR(100) NOT NULL,
  description TEXT
);

CREATE TABLE item_status (
  id BIGINT PRIMARY KEY,
  status_code VARCHAR(50) UNIQUE NOT NULL,
  status_name VARCHAR(100) NOT NULL
);

CREATE TABLE stock_transactions (
  id BIGINT PRIMARY KEY,
  transaction_no VARCHAR(100) UNIQUE NOT NULL,
  qr_code_id BIGINT NOT NULL,
  entity_type VARCHAR(30) NOT NULL,
  entity_id BIGINT NOT NULL,
  action_type VARCHAR(30) NOT NULL,
  qty DECIMAL(18,2) NOT NULL DEFAULT 0,
  from_location_id BIGINT,
  to_location_id BIGINT,
  reference_job_id BIGINT,
  reference_work_order_id BIGINT,
  status_after_id BIGINT,
  performed_by BIGINT NOT NULL,
  performed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  remark TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_transactions_qr_code FOREIGN KEY (qr_code_id) REFERENCES qr_codes(id),
  CONSTRAINT fk_transactions_from_location FOREIGN KEY (from_location_id) REFERENCES locations(id),
  CONSTRAINT fk_transactions_to_location FOREIGN KEY (to_location_id) REFERENCES locations(id),
  CONSTRAINT fk_transactions_reference_job FOREIGN KEY (reference_job_id) REFERENCES jobs(id),
  CONSTRAINT fk_transactions_reference_work_order FOREIGN KEY (reference_work_order_id) REFERENCES work_orders(id),
  CONSTRAINT fk_transactions_status FOREIGN KEY (status_after_id) REFERENCES item_status(id),
  CONSTRAINT fk_transactions_user FOREIGN KEY (performed_by) REFERENCES users(id)
);

CREATE TABLE stock_balances (
  id BIGINT PRIMARY KEY,
  entity_type VARCHAR(30) NOT NULL,
  entity_id BIGINT NOT NULL,
  qty_on_hand DECIMAL(18,2) NOT NULL DEFAULT 0,
  current_status_id BIGINT,
  current_location_id BIGINT,
  last_transaction_id BIGINT,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_balance_entity UNIQUE (entity_type, entity_id),
  CONSTRAINT fk_balances_status FOREIGN KEY (current_status_id) REFERENCES item_status(id),
  CONSTRAINT fk_balances_location FOREIGN KEY (current_location_id) REFERENCES locations(id),
  CONSTRAINT fk_balances_last_transaction FOREIGN KEY (last_transaction_id) REFERENCES stock_transactions(id)
);

CREATE INDEX idx_qr_codes_qr_value ON qr_codes(qr_value);
CREATE INDEX idx_transactions_entity ON stock_transactions(entity_type, entity_id);
CREATE INDEX idx_transactions_performed_at ON stock_transactions(performed_at DESC);
