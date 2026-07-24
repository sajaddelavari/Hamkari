const DEFAULT_ORGANIZATION_ID = 'default-organization';

function quotedIdentifier(identifier) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

function columnNames(db, table) {
  return new Set(
    db.prepare(`PRAGMA table_info(${quotedIdentifier(table)})`).all()
      .map((row) => row.name),
  );
}

function ensureColumn(db, table, column, definition) {
  const exists = db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type='table' AND name=?
  `).get(table);
  if (!exists) return;
  if (!columnNames(db, table).has(column)) {
    db.exec(
      `ALTER TABLE ${quotedIdentifier(table)}
       ADD COLUMN ${quotedIdentifier(column)} ${definition}`,
    );
  }
}

function tableExists(db, table) {
  return Boolean(
    db.prepare(`
      SELECT 1 FROM sqlite_master WHERE type='table' AND name=?
    `).get(table),
  );
}

export function syncLegacyFinance(db, now = new Date().toISOString()) {
  if (
    !tableExists(db, 'financial_entries') ||
    !tableExists(db, 'project_stakeholders')
  ) return;
  const projects = db.prepare(`
    SELECT p.id,p.organization_id,p.currency,
           MIN(f.occurred_on) AS first_date,
           MAX(f.occurred_on) AS last_date
    FROM projects p
    JOIN financial_entries f ON f.project_id=p.id
    GROUP BY p.id
    ORDER BY p.organization_id,p.id
  `).all();
  const accountDefinitions = [
    ['cash', '1000', 'وجه نقد و بانک', 'asset'],
    ['receivable', '1200', 'حساب‌های دریافتنی', 'asset'],
    ['payable', '2000', 'حساب‌های پرداختنی', 'liability'],
    ['distribution-payable', '2100', 'سود سهام پرداختنی', 'liability'],
    ['capital', '3000', 'سرمایه پرداخت‌شده', 'equity'],
    ['retained', '3100', 'سود و زیان انباشته', 'equity'],
    ['revenue', '4000', 'درآمد عملیاتی', 'revenue'],
    ['expense', '5000', 'هزینه‌های عملیاتی', 'expense'],
  ];
  const nextNoByOrganization = new Map();
  const insertAccount = db.prepare(`
    INSERT OR IGNORE INTO accounting_accounts(
      id,organization_id,project_id,code,name,account_type,parent_id,
      currency,active,system_key,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,NULL,?,1,?,?,?)
  `);
  const insertPeriod = db.prepare(`
    INSERT INTO fiscal_periods(
      id,organization_id,project_id,name,starts_on,ends_on,status,
      closed_at,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,'closed',?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      starts_on=MIN(fiscal_periods.starts_on,excluded.starts_on),
      ends_on=MAX(fiscal_periods.ends_on,excluded.ends_on),
      updated_at=excluded.updated_at
  `);
  const insertJournal = db.prepare(`
    INSERT OR IGNORE INTO journal_entries(
      id,organization_id,project_id,fiscal_period_id,entry_no,occurred_on,
      description,currency,status,source_type,source_id,created_by_user_id,
      posted_by_user_id,posted_at,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,'draft','legacy_financial_entry',?,NULL,NULL,NULL,?,?)
  `);
  const insertLine = db.prepare(`
    INSERT OR IGNORE INTO journal_lines(
      id,journal_entry_id,account_id,stakeholder_id,description,
      debit,credit,created_at
    ) VALUES(?,?,?,?,?,?,?,?)
  `);
  const insertValuation = db.prepare(`
    INSERT OR IGNORE INTO valuation_events(
      id,project_id,amount,currency,valued_on,description,
      source_type,source_id,created_at
    ) VALUES(?,?,?,?,?,?, 'legacy_financial_entry',?,?)
  `);

  for (const project of projects) {
    const prefix = `migration-account-${project.id}`;
    for (const [key, code, name, type] of accountDefinitions) {
      insertAccount.run(
        `${prefix}-${key}`,
        project.organization_id,
        project.id,
        code,
        name,
        type,
        project.currency || 'IRR',
        key,
        now,
        now,
      );
    }
    const periodId = `migration-period-${project.id}`;
    insertPeriod.run(
      periodId,
      project.organization_id,
      project.id,
      'دورهٔ انتقال داده‌های نسخهٔ پیشین',
      project.first_date || now.slice(0, 10),
      project.last_date || now.slice(0, 10),
      now,
      now,
      now,
    );
    if (!nextNoByOrganization.has(project.organization_id)) {
      const next = Number(db.prepare(`
        SELECT COALESCE(MAX(entry_no),0)+1 AS value
        FROM journal_entries WHERE organization_id=?
      `).get(project.organization_id).value);
      nextNoByOrganization.set(project.organization_id, next);
    }
    const entries = db.prepare(`
      SELECT * FROM financial_entries
      WHERE project_id=?
      ORDER BY occurred_on,created_at,id
    `).all(project.id);
    for (const entry of entries) {
      if (entry.type === 'valuation') {
        insertValuation.run(
          `legacy-valuation-${entry.id}`,
          project.id,
          entry.amount,
          project.currency || 'IRR',
          entry.occurred_on,
          entry.description || '',
          entry.id,
          entry.created_at || now,
        );
        continue;
      }
      const entryNo = nextNoByOrganization.get(project.organization_id);
      nextNoByOrganization.set(project.organization_id, entryNo + 1);
      const journalId = `legacy-journal-${entry.id}`;
      const createdAt = entry.created_at || now;
      const journalResult = insertJournal.run(
        journalId,
        project.organization_id,
        project.id,
        periodId,
        entryNo,
        entry.occurred_on,
        entry.description || `انتقال ثبت ${entry.id}`,
        project.currency || 'IRR',
        entry.id,
        createdAt,
        createdAt,
      );
      if (!Number(journalResult.changes)) continue;
      const normalAccounts = {
        revenue: ['cash', 'revenue'],
        expense: ['expense', 'cash'],
        investment: ['cash', 'capital'],
        distribution: ['retained', 'cash'],
      }[entry.type];
      if (!normalAccounts) continue;
      const [normalDebit, normalCredit] = normalAccounts;
      const reversed = Boolean(entry.reversal_of_entry_id);
      const debitKey = reversed ? normalCredit : normalDebit;
      const creditKey = reversed ? normalDebit : normalCredit;
      insertLine.run(
        `${journalId}-debit`,
        journalId,
        `${prefix}-${debitKey}`,
        entry.stakeholder_id || null,
        entry.description || '',
        entry.amount,
        0,
        createdAt,
      );
      insertLine.run(
        `${journalId}-credit`,
        journalId,
        `${prefix}-${creditKey}`,
        entry.stakeholder_id || null,
        entry.description || '',
        0,
        entry.amount,
        createdAt,
      );
      db.prepare(`
        UPDATE journal_entries
        SET status='posted',posted_at=?,updated_at=?
        WHERE id=? AND status='draft'
      `).run(createdAt, createdAt, journalId);
    }
  }
}

/**
 * Enterprise schema is deliberately isolated from the original MVP migrations.
 * Existing installations are upgraded in place and every legacy project is
 * assigned to a default organization without removing or rewriting its data.
 */
export function applyEnterpriseSchema(db) {
  const now = new Date().toISOString();

  db.exec(`
    CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      legal_name TEXT NOT NULL DEFAULT '',
      national_id TEXT NOT NULL DEFAULT '',
      website TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      logo_url TEXT NOT NULL DEFAULT '',
      timezone TEXT NOT NULL DEFAULT 'Asia/Tehran',
      default_currency TEXT NOT NULL DEFAULT 'IRR',
      status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active','suspended','archived')),
      settings_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      full_name TEXT NOT NULL,
      mobile TEXT NOT NULL DEFAULT '',
      avatar_url TEXT NOT NULL DEFAULT '',
      locale TEXT NOT NULL DEFAULT 'fa-IR',
      status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('invited','active','suspended','disabled')),
      email_verified_at TEXT,
      password_changed_at TEXT NOT NULL,
      mfa_enabled INTEGER NOT NULL DEFAULT 0 CHECK(mfa_enabled IN (0,1)),
      totp_secret_sealed TEXT,
      last_login_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS organization_memberships (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role_key TEXT NOT NULL
        CHECK(role_key IN ('owner','admin','project_manager','finance','board','auditor','viewer')),
      status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('invited','active','suspended')),
      joined_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(organization_id, user_id),
      FOREIGN KEY(organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS project_memberships (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role_key TEXT NOT NULL
        CHECK(role_key IN ('project_manager','contributor','finance','board','auditor','viewer')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(project_id, user_id),
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      csrf_token_hash TEXT NOT NULL,
      ip_hash TEXT NOT NULL DEFAULT '',
      user_agent TEXT NOT NULL DEFAULT '',
      mfa_verified_at TEXT,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS organization_invitations (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      email TEXT NOT NULL COLLATE NOCASE,
      role_key TEXT NOT NULL
        CHECK(role_key IN ('owner','admin','project_manager','finance','board','auditor','viewer')),
      project_id TEXT,
      project_role_key TEXT
        CHECK(project_role_key IS NULL OR project_role_key IN (
          'project_manager','contributor','finance','board','auditor','viewer'
        )),
      token_hash TEXT NOT NULL UNIQUE,
      invited_by_user_id TEXT,
      expires_at TEXT NOT NULL,
      accepted_at TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(invited_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS mfa_backup_codes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(user_id, code_hash),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      user_id TEXT,
      name TEXT NOT NULL,
      token_prefix TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      permissions_json TEXT NOT NULL DEFAULT '[]',
      last_used_at TEXT,
      expires_at TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS organization_memberships_user
      ON organization_memberships(user_id, status);
    CREATE INDEX IF NOT EXISTS project_memberships_user
      ON project_memberships(user_id, project_id);
    CREATE INDEX IF NOT EXISTS user_sessions_expiry
      ON user_sessions(expires_at, revoked_at);
    CREATE INDEX IF NOT EXISTS invitations_email
      ON organization_invitations(email, expires_at);
  `);

  db.prepare(`
    INSERT OR IGNORE INTO organizations(
      id, slug, name, description, created_at, updated_at
    ) VALUES(?,?,?,?,?,?)
  `).run(
    DEFAULT_ORGANIZATION_ID,
    'hamkari',
    'سازمان هم‌ساخت',
    'سازمان پیش‌فرض ایجادشده هنگام ارتقا از نسخهٔ پیشین.',
    now,
    now,
  );

  ensureColumn(
    db,
    'projects',
    'organization_id',
    `TEXT NOT NULL DEFAULT '${DEFAULT_ORGANIZATION_ID}'`,
  );
  ensureColumn(db, 'projects', 'updated_at', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'projects', 'currency', "TEXT NOT NULL DEFAULT 'IRR'");
  ensureColumn(db, 'projects', 'code', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(
    db,
    'projects',
    'visibility',
    "TEXT NOT NULL DEFAULT 'public' CHECK(visibility IN ('public','unlisted','private'))",
  );
  ensureColumn(
    db,
    'projects',
    'lifecycle',
    "TEXT NOT NULL DEFAULT 'planning' CHECK(lifecycle IN ('idea','planning','fundraising','executing','operating','completed','paused','cancelled'))",
  );
  ensureColumn(db, 'projects', 'planned_end_date', 'TEXT');
  ensureColumn(db, 'projects', 'actual_end_date', 'TEXT');
  ensureColumn(db, 'projects', 'owner_user_id', 'TEXT');
  db.prepare(`
    UPDATE projects
    SET organization_id=?
    WHERE organization_id IS NULL OR organization_id=''
  `).run(DEFAULT_ORGANIZATION_ID);
  db.exec(`
    CREATE INDEX IF NOT EXISTS projects_organization
      ON projects(organization_id, archived_at, updated_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS projects_org_code_unique
      ON projects(organization_id, code) WHERE code <> '';
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS project_phases (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'planned'
        CHECK(status IN ('planned','active','completed','blocked','cancelled')),
      progress_method TEXT NOT NULL DEFAULT 'tasks'
        CHECK(progress_method IN ('manual','tasks','milestones')),
      manual_progress REAL NOT NULL DEFAULT 0 CHECK(manual_progress BETWEEN 0 AND 100),
      planned_start TEXT,
      planned_end TEXT,
      actual_start TEXT,
      actual_end TEXT,
      order_no INTEGER NOT NULL DEFAULT 0,
      archived_at TEXT,
      created_by_user_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS project_tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      phase_id TEXT,
      parent_task_id TEXT,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'todo'
        CHECK(status IN ('backlog','todo','in_progress','blocked','review','done','cancelled')),
      priority TEXT NOT NULL DEFAULT 'medium'
        CHECK(priority IN ('low','medium','high','critical')),
      progress_percent REAL NOT NULL DEFAULT 0 CHECK(progress_percent BETWEEN 0 AND 100),
      weight REAL NOT NULL DEFAULT 1 CHECK(weight > 0),
      assignee_user_id TEXT,
      planned_start TEXT,
      due_date TEXT,
      started_at TEXT,
      completed_at TEXT,
      estimated_minutes INTEGER CHECK(estimated_minutes IS NULL OR estimated_minutes >= 0),
      actual_minutes INTEGER NOT NULL DEFAULT 0 CHECK(actual_minutes >= 0),
      order_no INTEGER NOT NULL DEFAULT 0,
      archived_at TEXT,
      created_by_user_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(phase_id) REFERENCES project_phases(id) ON DELETE SET NULL,
      FOREIGN KEY(parent_task_id) REFERENCES project_tasks(id) ON DELETE SET NULL,
      FOREIGN KEY(assignee_user_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY(created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS task_dependencies (
      task_id TEXT NOT NULL,
      depends_on_task_id TEXT NOT NULL,
      dependency_type TEXT NOT NULL DEFAULT 'finish_to_start'
        CHECK(dependency_type IN ('finish_to_start','start_to_start','finish_to_finish','start_to_finish')),
      lag_days INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      PRIMARY KEY(task_id, depends_on_task_id),
      CHECK(task_id <> depends_on_task_id),
      FOREIGN KEY(task_id) REFERENCES project_tasks(id) ON DELETE CASCADE,
      FOREIGN KEY(depends_on_task_id) REFERENCES project_tasks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS time_entries (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      minutes INTEGER NOT NULL CHECK(minutes > 0),
      worked_on TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(task_id) REFERENCES project_tasks(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS project_resources (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL
        CHECK(kind IN ('person','equipment','facility','material','service','capital')),
      unit TEXT NOT NULL DEFAULT '',
      capacity REAL,
      unit_cost INTEGER CHECK(unit_cost IS NULL OR unit_cost >= 0),
      currency TEXT NOT NULL DEFAULT 'IRR',
      owner_stakeholder_id TEXT,
      status TEXT NOT NULL DEFAULT 'available'
        CHECK(status IN ('available','allocated','unavailable','retired')),
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(owner_stakeholder_id) REFERENCES project_stakeholders(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS resource_allocations (
      id TEXT PRIMARY KEY,
      resource_id TEXT NOT NULL,
      task_id TEXT,
      phase_id TEXT,
      quantity REAL NOT NULL CHECK(quantity > 0),
      starts_on TEXT,
      ends_on TEXT,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK(task_id IS NOT NULL OR phase_id IS NOT NULL),
      FOREIGN KEY(resource_id) REFERENCES project_resources(id) ON DELETE CASCADE,
      FOREIGN KEY(task_id) REFERENCES project_tasks(id) ON DELETE CASCADE,
      FOREIGN KEY(phase_id) REFERENCES project_phases(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS project_risks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'risk'
        CHECK(kind IN ('risk','issue','assumption','dependency')),
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT '',
      probability INTEGER NOT NULL DEFAULT 1 CHECK(probability BETWEEN 1 AND 5),
      impact INTEGER NOT NULL DEFAULT 1 CHECK(impact BETWEEN 1 AND 5),
      status TEXT NOT NULL DEFAULT 'open'
        CHECK(status IN ('open','mitigating','accepted','resolved','closed')),
      response_strategy TEXT NOT NULL DEFAULT '',
      owner_user_id TEXT,
      due_date TEXT,
      resolved_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(owner_user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS project_kpis (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      unit TEXT NOT NULL DEFAULT '',
      direction TEXT NOT NULL DEFAULT 'increase'
        CHECK(direction IN ('increase','decrease','maintain')),
      baseline_value REAL,
      target_value REAL NOT NULL,
      warning_value REAL,
      current_value REAL,
      frequency TEXT NOT NULL DEFAULT 'monthly'
        CHECK(frequency IN ('daily','weekly','monthly','quarterly','annual','on_demand')),
      owner_user_id TEXT,
      starts_on TEXT,
      target_date TEXT,
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(owner_user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS kpi_measurements (
      id TEXT PRIMARY KEY,
      kpi_id TEXT NOT NULL,
      value REAL NOT NULL,
      measured_at TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      evidence_document_id TEXT,
      created_by_user_id TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(kpi_id, measured_at),
      FOREIGN KEY(kpi_id) REFERENCES project_kpis(id) ON DELETE CASCADE,
      FOREIGN KEY(created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS progress_updates (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      phase_id TEXT,
      task_id TEXT,
      progress_percent REAL NOT NULL CHECK(progress_percent BETWEEN 0 AND 100),
      summary TEXT NOT NULL,
      blockers TEXT NOT NULL DEFAULT '',
      next_steps TEXT NOT NULL DEFAULT '',
      evidence_document_id TEXT,
      reported_by_user_id TEXT,
      reported_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(phase_id) REFERENCES project_phases(id) ON DELETE SET NULL,
      FOREIGN KEY(task_id) REFERENCES project_tasks(id) ON DELETE SET NULL,
      FOREIGN KEY(reported_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS budget_versions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      version_no INTEGER NOT NULL CHECK(version_no > 0),
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK(status IN ('draft','approved','superseded','cancelled')),
      currency TEXT NOT NULL DEFAULT 'IRR',
      period_start TEXT,
      period_end TEXT,
      approved_by_user_id TEXT,
      approved_at TEXT,
      created_by_user_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(project_id, version_no),
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(approved_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY(created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS budget_lines (
      id TEXT PRIMARY KEY,
      budget_version_id TEXT NOT NULL,
      parent_id TEXT,
      account_code TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT '',
      planned_amount INTEGER NOT NULL CHECK(planned_amount >= 0),
      notes TEXT NOT NULL DEFAULT '',
      order_no INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(budget_version_id) REFERENCES budget_versions(id) ON DELETE CASCADE,
      FOREIGN KEY(parent_id) REFERENCES budget_lines(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS phases_project_order
      ON project_phases(project_id, archived_at, order_no);
    CREATE INDEX IF NOT EXISTS tasks_project_status
      ON project_tasks(project_id, archived_at, status, due_date);
    CREATE INDEX IF NOT EXISTS tasks_assignee
      ON project_tasks(assignee_user_id, status, due_date);
    CREATE INDEX IF NOT EXISTS risks_project_score
      ON project_risks(project_id, status, probability DESC, impact DESC);
    CREATE INDEX IF NOT EXISTS kpi_measurements_kpi
      ON kpi_measurements(kpi_id, measured_at DESC);
    CREATE INDEX IF NOT EXISTS budget_versions_project
      ON budget_versions(project_id, status, version_no DESC);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      project_id TEXT,
      folder TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'other'
        CHECK(category IN ('project','financial','legal','contract','identity','meeting','evidence','report','other')),
      visibility TEXT NOT NULL DEFAULT 'private'
        CHECK(visibility IN ('private','organization','project','public')),
      status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('draft','active','archived')),
      current_version_no INTEGER NOT NULL DEFAULT 0 CHECK(current_version_no >= 0),
      created_by_user_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      FOREIGN KEY(organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS document_versions (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      version_no INTEGER NOT NULL CHECK(version_no > 0),
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
      sha256 TEXT NOT NULL,
      content BLOB NOT NULL,
      change_note TEXT NOT NULL DEFAULT '',
      uploaded_by_user_id TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(document_id, version_no),
      FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE,
      FOREIGN KEY(uploaded_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS document_links (
      document_id TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(document_id, resource_type, resource_id),
      FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS kyc_cases (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      project_id TEXT,
      subject_type TEXT NOT NULL CHECK(subject_type IN ('user','stakeholder','organization')),
      subject_id TEXT NOT NULL,
      level TEXT NOT NULL DEFAULT 'basic'
        CHECK(level IN ('basic','enhanced')),
      provider TEXT NOT NULL DEFAULT 'manual',
      provider_reference TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','in_review','verified','rejected','expired')),
      risk_rating TEXT NOT NULL DEFAULT 'unknown'
        CHECK(risk_rating IN ('unknown','low','medium','high')),
      decision_reason TEXT NOT NULL DEFAULT '',
      requested_at TEXT NOT NULL,
      reviewed_by_user_id TEXT,
      reviewed_at TEXT,
      expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(reviewed_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS kyc_checks (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      check_type TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'manual',
      status TEXT NOT NULL CHECK(status IN ('pending','passed','failed','needs_review')),
      result_json TEXT NOT NULL DEFAULT '{}',
      evidence_document_id TEXT,
      checked_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(case_id) REFERENCES kyc_cases(id) ON DELETE CASCADE,
      FOREIGN KEY(evidence_document_id) REFERENCES documents(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS contracts (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      project_id TEXT,
      title TEXT NOT NULL,
      contract_type TEXT NOT NULL DEFAULT 'other',
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK(status IN ('draft','review','awaiting_signatures','active','completed','terminated','cancelled')),
      document_id TEXT,
      effective_on TEXT,
      expires_on TEXT,
      value_amount INTEGER CHECK(value_amount IS NULL OR value_amount >= 0),
      currency TEXT NOT NULL DEFAULT 'IRR',
      owner_user_id TEXT,
      created_by_user_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE SET NULL,
      FOREIGN KEY(owner_user_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY(created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS contract_parties (
      id TEXT PRIMARY KEY,
      contract_id TEXT NOT NULL,
      party_type TEXT NOT NULL CHECK(party_type IN ('organization','user','stakeholder','external')),
      party_id TEXT,
      display_name TEXT NOT NULL,
      email TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'party',
      signing_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY(contract_id) REFERENCES contracts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS contract_signatures (
      id TEXT PRIMARY KEY,
      contract_id TEXT NOT NULL,
      party_id TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'manual',
      provider_reference TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','sent','viewed','signed','declined','expired','revoked')),
      signature_hash TEXT NOT NULL DEFAULT '',
      signed_document_id TEXT,
      signed_at TEXT,
      ip_hash TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(contract_id, party_id),
      FOREIGN KEY(contract_id) REFERENCES contracts(id) ON DELETE CASCADE,
      FOREIGN KEY(party_id) REFERENCES contract_parties(id) ON DELETE CASCADE,
      FOREIGN KEY(signed_document_id) REFERENCES documents(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS documents_project
      ON documents(project_id, archived_at, updated_at DESC);
    CREATE INDEX IF NOT EXISTS kyc_subject
      ON kyc_cases(organization_id, subject_type, subject_id, status);
    CREATE INDEX IF NOT EXISTS contracts_project
      ON contracts(project_id, status, updated_at DESC);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS accounting_accounts (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      project_id TEXT,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      account_type TEXT NOT NULL
        CHECK(account_type IN ('asset','liability','equity','revenue','expense')),
      parent_id TEXT,
      currency TEXT NOT NULL DEFAULT 'IRR',
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      system_key TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(organization_id, project_id, code),
      FOREIGN KEY(organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(parent_id) REFERENCES accounting_accounts(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS fiscal_periods (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      project_id TEXT,
      name TEXT NOT NULL,
      starts_on TEXT NOT NULL,
      ends_on TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open'
        CHECK(status IN ('open','closing','closed')),
      closed_by_user_id TEXT,
      closed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK(starts_on <= ends_on),
      FOREIGN KEY(organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(closed_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS journal_entries (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      project_id TEXT,
      fiscal_period_id TEXT,
      entry_no INTEGER NOT NULL,
      occurred_on TEXT NOT NULL,
      description TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'IRR',
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK(status IN ('draft','posted','reversed')),
      source_type TEXT NOT NULL DEFAULT 'manual',
      source_id TEXT,
      reversal_of_id TEXT,
      idempotency_key_hash TEXT,
      request_hash TEXT,
      created_by_user_id TEXT,
      posted_by_user_id TEXT,
      posted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(organization_id, entry_no),
      UNIQUE(organization_id, idempotency_key_hash),
      FOREIGN KEY(organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(fiscal_period_id) REFERENCES fiscal_periods(id) ON DELETE RESTRICT,
      FOREIGN KEY(reversal_of_id) REFERENCES journal_entries(id) ON DELETE RESTRICT,
      FOREIGN KEY(created_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY(posted_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS journal_lines (
      id TEXT PRIMARY KEY,
      journal_entry_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      stakeholder_id TEXT,
      description TEXT NOT NULL DEFAULT '',
      debit INTEGER NOT NULL DEFAULT 0 CHECK(debit >= 0),
      credit INTEGER NOT NULL DEFAULT 0 CHECK(credit >= 0),
      created_at TEXT NOT NULL,
      CHECK((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0)),
      FOREIGN KEY(journal_entry_id) REFERENCES journal_entries(id) ON DELETE CASCADE,
      FOREIGN KEY(account_id) REFERENCES accounting_accounts(id) ON DELETE RESTRICT,
      FOREIGN KEY(stakeholder_id) REFERENCES project_stakeholders(id) ON DELETE SET NULL
    );

    CREATE TRIGGER IF NOT EXISTS journal_lines_posted_no_insert
    BEFORE INSERT ON journal_lines
    WHEN EXISTS(
      SELECT 1 FROM journal_entries
      WHERE id=NEW.journal_entry_id AND status <> 'draft'
    )
    BEGIN SELECT RAISE(ABORT, 'posted journal is immutable'); END;

    CREATE TRIGGER IF NOT EXISTS journal_lines_posted_no_update
    BEFORE UPDATE ON journal_lines
    WHEN EXISTS(
      SELECT 1 FROM journal_entries
      WHERE id=OLD.journal_entry_id AND status <> 'draft'
    )
    BEGIN SELECT RAISE(ABORT, 'posted journal is immutable'); END;

    CREATE TRIGGER IF NOT EXISTS journal_lines_posted_no_delete
    BEFORE DELETE ON journal_lines
    WHEN EXISTS(
      SELECT 1 FROM journal_entries
      WHERE id=OLD.journal_entry_id AND status <> 'draft'
    )
    BEGIN SELECT RAISE(ABORT, 'posted journal is immutable'); END;

    CREATE TRIGGER IF NOT EXISTS journal_entries_posted_no_delete
    BEFORE DELETE ON journal_entries
    WHEN OLD.status <> 'draft'
    BEGIN SELECT RAISE(ABORT, 'posted journal is immutable'); END;

    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      project_id TEXT,
      kind TEXT NOT NULL CHECK(kind IN ('receivable','payable')),
      counterparty_type TEXT NOT NULL DEFAULT 'external',
      counterparty_id TEXT,
      counterparty_name TEXT NOT NULL,
      invoice_no TEXT NOT NULL,
      issued_on TEXT NOT NULL,
      due_on TEXT,
      currency TEXT NOT NULL DEFAULT 'IRR',
      subtotal INTEGER NOT NULL CHECK(subtotal >= 0),
      tax_amount INTEGER NOT NULL DEFAULT 0 CHECK(tax_amount >= 0),
      discount_amount INTEGER NOT NULL DEFAULT 0 CHECK(discount_amount >= 0),
      total_amount INTEGER NOT NULL CHECK(total_amount >= 0),
      paid_amount INTEGER NOT NULL DEFAULT 0 CHECK(paid_amount >= 0),
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK(status IN ('draft','issued','partially_paid','paid','overdue','void')),
      journal_entry_id TEXT,
      document_id TEXT,
      notes TEXT NOT NULL DEFAULT '',
      created_by_user_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(organization_id, kind, invoice_no),
      CHECK(paid_amount <= total_amount),
      FOREIGN KEY(organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(journal_entry_id) REFERENCES journal_entries(id) ON DELETE SET NULL,
      FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE SET NULL,
      FOREIGN KEY(created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS payment_intents (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      project_id TEXT,
      invoice_id TEXT,
      purpose_type TEXT
        CHECK(purpose_type IS NULL OR purpose_type IN (
          'invoice','share_transfer','preemptive_right','distribution','general'
        )),
      purpose_id TEXT,
      purpose_hash TEXT,
      direction TEXT NOT NULL CHECK(direction IN ('incoming','outgoing')),
      provider TEXT NOT NULL DEFAULT 'manual',
      provider_reference TEXT NOT NULL DEFAULT '',
      idempotency_key_hash TEXT NOT NULL,
      amount INTEGER NOT NULL CHECK(amount > 0),
      currency TEXT NOT NULL DEFAULT 'IRR',
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','requires_action','processing','succeeded','failed','cancelled','refunded')),
      failure_reason TEXT NOT NULL DEFAULT '',
      initiated_by_user_id TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(organization_id, idempotency_key_hash),
      FOREIGN KEY(organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(invoice_id) REFERENCES invoices(id) ON DELETE SET NULL,
      FOREIGN KEY(initiated_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS payment_events (
      id TEXT PRIMARY KEY,
      payment_intent_id TEXT NOT NULL,
      provider_event_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      received_at TEXT NOT NULL,
      UNIQUE(payment_intent_id, provider_event_id),
      FOREIGN KEY(payment_intent_id) REFERENCES payment_intents(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS distributions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      record_date TEXT NOT NULL,
      payable_on TEXT,
      currency TEXT NOT NULL DEFAULT 'IRR',
      total_amount INTEGER NOT NULL CHECK(total_amount > 0),
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK(status IN ('draft','approved','processing','paid','cancelled')),
      resolution_id TEXT,
      journal_entry_id TEXT,
      approved_by_user_id TEXT,
      approved_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(resolution_id) REFERENCES meeting_resolutions(id) ON DELETE SET NULL,
      FOREIGN KEY(journal_entry_id) REFERENCES journal_entries(id) ON DELETE SET NULL,
      FOREIGN KEY(approved_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS distribution_allocations (
      id TEXT PRIMARY KEY,
      distribution_id TEXT NOT NULL,
      stakeholder_id TEXT NOT NULL,
      eligible_units INTEGER NOT NULL CHECK(eligible_units >= 0),
      amount INTEGER NOT NULL CHECK(amount >= 0),
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','processing','paid','failed','withheld')),
      payment_intent_id TEXT,
      paid_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(distribution_id, stakeholder_id),
      FOREIGN KEY(distribution_id) REFERENCES distributions(id) ON DELETE CASCADE,
      FOREIGN KEY(stakeholder_id) REFERENCES project_stakeholders(id) ON DELETE RESTRICT,
      FOREIGN KEY(payment_intent_id) REFERENCES payment_intents(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS exchange_rates (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      base_currency TEXT NOT NULL,
      quote_currency TEXT NOT NULL,
      rate REAL NOT NULL CHECK(rate > 0),
      effective_on TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL,
      UNIQUE(organization_id, base_currency, quote_currency, effective_on),
      FOREIGN KEY(organization_id) REFERENCES organizations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS valuation_events (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      amount INTEGER NOT NULL CHECK(amount >= 0),
      currency TEXT NOT NULL DEFAULT 'IRR',
      valued_on TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      methodology TEXT NOT NULL DEFAULT '',
      source_type TEXT NOT NULL DEFAULT 'manual',
      source_id TEXT,
      document_id TEXT,
      created_by_user_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE SET NULL,
      FOREIGN KEY(created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS accounting_accounts_project
      ON accounting_accounts(organization_id, project_id, active, code);
    CREATE INDEX IF NOT EXISTS journal_entries_project
      ON journal_entries(project_id, occurred_on DESC, entry_no DESC);
    CREATE INDEX IF NOT EXISTS journal_lines_account
      ON journal_lines(account_id, journal_entry_id);
    CREATE INDEX IF NOT EXISTS invoices_project_status
      ON invoices(project_id, kind, status, due_on);
    CREATE INDEX IF NOT EXISTS payment_intents_project
      ON payment_intents(project_id, status, updated_at DESC);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS corporate_actions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      share_class_id TEXT,
      action_type TEXT NOT NULL
        CHECK(action_type IN ('issuance','capital_increase','split','reverse_split','conversion','buyback','cancellation','rights_issue')),
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK(status IN ('draft','approved','executing','completed','cancelled')),
      record_date TEXT,
      effective_date TEXT,
      ratio_numerator INTEGER CHECK(ratio_numerator IS NULL OR ratio_numerator > 0),
      ratio_denominator INTEGER CHECK(ratio_denominator IS NULL OR ratio_denominator > 0),
      units INTEGER CHECK(units IS NULL OR units > 0),
      unit_price INTEGER CHECK(unit_price IS NULL OR unit_price >= 0),
      resolution_id TEXT,
      notes TEXT NOT NULL DEFAULT '',
      approved_by_user_id TEXT,
      approved_at TEXT,
      approved_preview_hash TEXT,
      executed_by_user_id TEXT,
      executed_at TEXT,
      created_by_user_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(share_class_id) REFERENCES share_classes(id) ON DELETE RESTRICT,
      FOREIGN KEY(resolution_id) REFERENCES meeting_resolutions(id) ON DELETE SET NULL,
      FOREIGN KEY(approved_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY(executed_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY(created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS preemptive_rights (
      id TEXT PRIMARY KEY,
      corporate_action_id TEXT NOT NULL,
      stakeholder_id TEXT NOT NULL,
      entitled_units INTEGER NOT NULL CHECK(entitled_units >= 0),
      exercised_units INTEGER NOT NULL DEFAULT 0 CHECK(exercised_units >= 0),
      transferred_units INTEGER NOT NULL DEFAULT 0 CHECK(transferred_units >= 0),
      expires_on TEXT,
      status TEXT NOT NULL DEFAULT 'available'
        CHECK(status IN ('available','partially_exercised','exercised','transferred','expired','waived')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(corporate_action_id, stakeholder_id),
      CHECK(exercised_units + transferred_units <= entitled_units),
      FOREIGN KEY(corporate_action_id) REFERENCES corporate_actions(id) ON DELETE CASCADE,
      FOREIGN KEY(stakeholder_id) REFERENCES project_stakeholders(id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS share_certificates (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      share_class_id TEXT NOT NULL,
      stakeholder_id TEXT NOT NULL,
      certificate_no TEXT NOT NULL,
      units INTEGER NOT NULL CHECK(units > 0),
      issued_on TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active','replaced','cancelled')),
      document_id TEXT,
      replaced_by_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(project_id, certificate_no),
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(share_class_id) REFERENCES share_classes(id) ON DELETE RESTRICT,
      FOREIGN KEY(stakeholder_id) REFERENCES project_stakeholders(id) ON DELETE RESTRICT,
      FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE SET NULL,
      FOREIGN KEY(replaced_by_id) REFERENCES share_certificates(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS governance_proxies (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      meeting_id TEXT NOT NULL,
      grantor_stakeholder_id TEXT NOT NULL,
      proxy_stakeholder_id TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'meeting'
        CHECK(scope IN ('meeting','resolution')),
      resolution_id TEXT,
      voting_power INTEGER NOT NULL CHECK(voting_power > 0),
      status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active','revoked','expired','used')),
      granted_at TEXT NOT NULL,
      expires_at TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK(grantor_stakeholder_id <> proxy_stakeholder_id),
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(meeting_id) REFERENCES project_meetings(id) ON DELETE CASCADE,
      FOREIGN KEY(resolution_id) REFERENCES meeting_resolutions(id) ON DELETE CASCADE,
      FOREIGN KEY(grantor_stakeholder_id) REFERENCES project_stakeholders(id) ON DELETE RESTRICT,
      FOREIGN KEY(proxy_stakeholder_id) REFERENCES project_stakeholders(id) ON DELETE RESTRICT
    );
  `);

  ensureColumn(db, 'project_meetings', 'record_date', 'TEXT');
  ensureColumn(db, 'project_meetings', 'quorum_percent', 'REAL NOT NULL DEFAULT 50');
  ensureColumn(db, 'project_meetings', 'quorum_met', 'INTEGER');
  ensureColumn(
    db,
    'project_stakeholders',
    'user_id',
    'TEXT REFERENCES users(id) ON DELETE SET NULL',
  );
  ensureColumn(db, 'meeting_resolutions', 'approval_rule', "TEXT NOT NULL DEFAULT 'simple_majority'");
  ensureColumn(db, 'meeting_resolutions', 'approval_threshold', 'REAL NOT NULL DEFAULT 50');
  ensureColumn(db, 'meeting_resolutions', 'eligible_voting_power', 'INTEGER');
  ensureColumn(db, 'meeting_resolutions', 'quorum_required_percent', 'REAL NOT NULL DEFAULT 0');
  ensureColumn(db, 'meeting_resolutions', 'result_json', "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(
    db,
    'meeting_resolutions',
    'operation_type',
    `TEXT CHECK(operation_type IS NULL OR operation_type IN (
      'corporate_action','share_transfer'
    ))`,
  );
  ensureColumn(
    db,
    'meeting_resolutions',
    'operation_scope_json',
    "TEXT NOT NULL DEFAULT '{}'",
  );
  ensureColumn(db, 'meeting_resolutions', 'operation_request_hash', 'TEXT');
  ensureColumn(
    db,
    'resolution_votes',
    'cast_by_user_id',
    'TEXT REFERENCES users(id) ON DELETE SET NULL',
  );
  ensureColumn(
    db,
    'resolution_votes',
    'proxy_id',
    'TEXT REFERENCES governance_proxies(id) ON DELETE SET NULL',
  );
  ensureColumn(
    db,
    'payment_intents',
    'purpose_type',
    `TEXT CHECK(purpose_type IS NULL OR purpose_type IN (
      'invoice','share_transfer','preemptive_right','distribution','general'
    ))`,
  );
  ensureColumn(db, 'payment_intents', 'purpose_id', 'TEXT');
  ensureColumn(db, 'payment_intents', 'purpose_hash', 'TEXT');

  if (tableExists(db, 'project_stakeholders')) {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS project_stakeholders_user_once
        ON project_stakeholders(project_id, user_id)
        WHERE user_id IS NOT NULL;
    `);
  }
  if (tableExists(db, 'meeting_resolutions')) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS resolution_operation_scope_immutable
      BEFORE UPDATE OF
        operation_type,operation_scope_json,operation_request_hash
        ON meeting_resolutions
      WHEN OLD.status<>'draft'
        AND (
          OLD.operation_type IS NOT NEW.operation_type OR
          OLD.operation_scope_json IS NOT NEW.operation_scope_json OR
          OLD.operation_request_hash IS NOT NEW.operation_request_hash
        )
      BEGIN
        SELECT RAISE(ABORT, 'resolution operation scope is immutable');
      END;
    `);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS resolution_operation_bindings (
      resolution_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      operation_type TEXT NOT NULL
        CHECK(operation_type IN ('corporate_action','share_transfer')),
      operation_id TEXT NOT NULL UNIQUE,
      request_hash TEXT NOT NULL,
      bound_at TEXT NOT NULL,
      consumed_at TEXT,
      FOREIGN KEY(resolution_id)
        REFERENCES meeting_resolutions(id) ON DELETE RESTRICT,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS resolution_operation_bindings_project
      ON resolution_operation_bindings(project_id, operation_type, bound_at);
    CREATE TRIGGER IF NOT EXISTS resolution_operation_binding_immutable
    BEFORE UPDATE OF
      resolution_id,project_id,operation_type,operation_id,request_hash
      ON resolution_operation_bindings
    BEGIN
      SELECT RAISE(ABORT, 'resolution operation binding is immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS resolution_operation_binding_no_delete
    BEFORE DELETE ON resolution_operation_bindings
    BEGIN
      SELECT RAISE(ABORT, 'resolution operation binding is immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS resolution_operation_consumption_immutable
    BEFORE UPDATE OF consumed_at ON resolution_operation_bindings
    WHEN OLD.consumed_at IS NOT NULL
      AND OLD.consumed_at IS NOT NEW.consumed_at
    BEGIN
      SELECT RAISE(ABORT, 'resolution operation consumption is immutable');
    END;
    CREATE UNIQUE INDEX IF NOT EXISTS payment_share_transfer_purpose_once
      ON payment_intents(organization_id, purpose_type, purpose_id)
      WHERE purpose_type='share_transfer' AND purpose_id IS NOT NULL;

    CREATE TRIGGER IF NOT EXISTS payment_purpose_immutable
    BEFORE UPDATE OF purpose_type, purpose_id, purpose_hash ON payment_intents
    WHEN (
        OLD.purpose_type IS NOT NULL OR
        OLD.purpose_id IS NOT NULL OR
        OLD.purpose_hash IS NOT NULL
      )
      AND (
        OLD.purpose_type IS NOT NEW.purpose_type OR
        OLD.purpose_id IS NOT NEW.purpose_id OR
        OLD.purpose_hash IS NOT NEW.purpose_hash
      )
    BEGIN
      SELECT RAISE(ABORT, 'payment purpose is immutable');
    END;

    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      project_id TEXT,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      parent_id TEXT,
      body TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'team'
        CHECK(visibility IN ('private','team','board','public')),
      author_user_id TEXT,
      edited_at TEXT,
      deleted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(parent_id) REFERENCES comments(id) ON DELETE CASCADE,
      FOREIGN KEY(author_user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS decision_actions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      meeting_id TEXT,
      resolution_id TEXT,
      title TEXT NOT NULL,
      assignee_user_id TEXT,
      due_date TEXT,
      status TEXT NOT NULL DEFAULT 'open'
        CHECK(status IN ('open','in_progress','done','cancelled')),
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(meeting_id) REFERENCES project_meetings(id) ON DELETE CASCADE,
      FOREIGN KEY(resolution_id) REFERENCES meeting_resolutions(id) ON DELETE CASCADE,
      FOREIGN KEY(assignee_user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      project_id TEXT,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      action_url TEXT NOT NULL DEFAULT '',
      read_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS notification_preferences (
      user_id TEXT NOT NULL,
      channel TEXT NOT NULL CHECK(channel IN ('in_app','email','sms','webhook')),
      event_key TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
      quiet_hours_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL,
      PRIMARY KEY(user_id, channel, event_key),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS notification_outbox (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      user_id TEXT,
      channel TEXT NOT NULL CHECK(channel IN ('email','sms','webhook')),
      destination TEXT NOT NULL,
      template_key TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'manual',
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','processing','sent','failed','cancelled')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
      next_attempt_at TEXT,
      sent_at TEXT,
      last_error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS webhooks (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      name TEXT NOT NULL,
      endpoint_url TEXT NOT NULL,
      secret_hash TEXT NOT NULL,
      event_keys_json TEXT NOT NULL DEFAULT '[]',
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      created_by_user_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
      FOREIGN KEY(created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id TEXT PRIMARY KEY,
      webhook_id TEXT NOT NULL,
      event_key TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','processing','delivered','failed','cancelled')),
      attempts INTEGER NOT NULL DEFAULT 0,
      response_status INTEGER,
      response_excerpt TEXT NOT NULL DEFAULT '',
      next_attempt_at TEXT,
      delivered_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(webhook_id) REFERENCES webhooks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS integration_connections (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      provider_key TEXT NOT NULL,
      display_name TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'manual'
        CHECK(mode IN ('manual','sandbox','live')),
      status TEXT NOT NULL DEFAULT 'inactive'
        CHECK(status IN ('inactive','configured','healthy','degraded','disabled')),
      config_sealed TEXT NOT NULL DEFAULT '',
      last_checked_at TEXT,
      last_error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(organization_id, provider_key),
      FOREIGN KEY(organization_id) REFERENCES organizations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS report_runs (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      project_id TEXT,
      report_key TEXT NOT NULL,
      format TEXT NOT NULL CHECK(format IN ('json','csv','html')),
      parameters_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'queued'
        CHECK(status IN ('queued','processing','completed','failed','expired')),
      result_document_id TEXT,
      error_message TEXT NOT NULL DEFAULT '',
      requested_by_user_id TEXT,
      requested_at TEXT NOT NULL,
      completed_at TEXT,
      expires_at TEXT,
      FOREIGN KEY(organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(result_document_id) REFERENCES documents(id) ON DELETE SET NULL,
      FOREIGN KEY(requested_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS organization_public_profiles (
      organization_id TEXT PRIMARY KEY,
      headline TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      website TEXT NOT NULL DEFAULT '',
      contact_email TEXT NOT NULL DEFAULT '',
      verified INTEGER NOT NULL DEFAULT 0 CHECK(verified IN (0,1)),
      published INTEGER NOT NULL DEFAULT 0 CHECK(published IN (0,1)),
      updated_at TEXT NOT NULL,
      FOREIGN KEY(organization_id) REFERENCES organizations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS marketplace_listings (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      listing_type TEXT NOT NULL
        CHECK(listing_type IN ('collaboration','investment','share_offer','supplier','expert')),
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      tags_json TEXT NOT NULL DEFAULT '[]',
      minimum_amount INTEGER,
      maximum_amount INTEGER,
      currency TEXT NOT NULL DEFAULT 'IRR',
      location TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK(status IN ('draft','published','paused','closed','archived')),
      published_at TEXT,
      closes_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS saved_listings (
      user_id TEXT NOT NULL,
      listing_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(user_id, listing_id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(listing_id) REFERENCES marketplace_listings(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS enterprise_audit_events (
      id TEXT PRIMARY KEY,
      organization_id TEXT,
      project_id TEXT,
      actor_type TEXT NOT NULL CHECK(actor_type IN ('user','legacy_admin','api_key','system','provider')),
      actor_id TEXT,
      request_id TEXT NOT NULL DEFAULT '',
      ip_hash TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL DEFAULT '',
      before_json TEXT,
      after_json TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      previous_hash TEXT NOT NULL DEFAULT '',
      event_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(organization_id) REFERENCES organizations(id) ON DELETE SET NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS comments_resource
      ON comments(resource_type, resource_id, deleted_at, created_at);
    CREATE INDEX IF NOT EXISTS decision_actions_assignee
      ON decision_actions(assignee_user_id, status, due_date);
    CREATE INDEX IF NOT EXISTS notifications_user
      ON notifications(user_id, read_at, created_at DESC);
    CREATE INDEX IF NOT EXISTS notification_outbox_due
      ON notification_outbox(status, next_attempt_at, created_at);
    CREATE INDEX IF NOT EXISTS report_runs_requester
      ON report_runs(requested_by_user_id, requested_at DESC);
    CREATE INDEX IF NOT EXISTS marketplace_published
      ON marketplace_listings(status, listing_type, published_at DESC);
    CREATE INDEX IF NOT EXISTS enterprise_audit_scope
      ON enterprise_audit_events(organization_id, project_id, created_at DESC);

    CREATE TRIGGER IF NOT EXISTS enterprise_audit_no_update
    BEFORE UPDATE ON enterprise_audit_events
    BEGIN SELECT RAISE(ABORT, 'enterprise audit is immutable'); END;

    CREATE TRIGGER IF NOT EXISTS enterprise_audit_no_delete
    BEFORE DELETE ON enterprise_audit_events
    BEGIN SELECT RAISE(ABORT, 'enterprise audit is immutable'); END;
  `);

  syncLegacyFinance(db, now);
}

export const enterpriseSchemaInternals = Object.freeze({
  DEFAULT_ORGANIZATION_ID,
});
