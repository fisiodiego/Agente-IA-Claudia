import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'patients.db');

// Garantir que o diretório data existe
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);

// Habilitar WAL e foreign keys via exec
db.exec(`PRAGMA journal_mode = WAL`);
db.exec(`PRAGMA foreign_keys = ON`);

// ─── Criação das Tabelas ───────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS patients (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT    NOT NULL,
    phone            TEXT    UNIQUE NOT NULL,
    birth_date       TEXT,                          -- data de nascimento (dd/mm/aaaa)
    contact_phone    TEXT,                          -- telefone de contato informado pelo paciente
    email            TEXT,
    status           TEXT    DEFAULT 'cadastro_pendente',
    -- cadastro_pendente | em_tratamento | alta_confirmada | inativo
    registration_complete INTEGER DEFAULT 0,        -- 1 quando nome+nascimento+tel coletados
    first_appointment_date TEXT,
    discharge_date   TEXT,
    specialty        TEXT,                          -- osteopatia | quiropraxia | ambos
    notes            TEXT,
    created_at       TEXT    DEFAULT (datetime('now','localtime')),
    updated_at       TEXT    DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS followups (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id   INTEGER NOT NULL,
    type         TEXT    NOT NULL,
    -- Tipos: pesquisa_satisfacao | lembrete_1mes | lembrete_3meses | lembrete_6meses | lembrete_12meses
    scheduled_date TEXT  NOT NULL,
    sent_at      TEXT,
    status       TEXT    DEFAULT 'pendente', -- pendente | enviado | respondido | cancelado
    response     TEXT,
    created_at   TEXT    DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id INTEGER NOT NULL,
    role       TEXT    NOT NULL, -- user | assistant
    content    TEXT    NOT NULL,
    created_at TEXT    DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS message_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    phone      TEXT    NOT NULL,
    direction  TEXT    NOT NULL, -- inbound | outbound
    content    TEXT    NOT NULL,
    type       TEXT    DEFAULT 'text',
    created_at TEXT    DEFAULT (datetime('now','localtime'))
  );
`);

// Adicionar coluna lgpd_consent se ainda não existir (migração segura)
try {
  db.exec(`ALTER TABLE patients ADD COLUMN lgpd_consent INTEGER DEFAULT 0`);
} catch (_) { /* coluna já existe */ }

// ─── Índices para performance ──────────────────────────────────────────────────

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_patients_phone   ON patients(phone);
  CREATE INDEX IF NOT EXISTS idx_patients_status  ON patients(status);
  CREATE INDEX IF NOT EXISTS idx_followups_status ON followups(status);
  CREATE INDEX IF NOT EXISTS idx_followups_date   ON followups(scheduled_date);
  CREATE INDEX IF NOT EXISTS idx_conversations_patient ON conversations(patient_id);

  CREATE TABLE IF NOT EXISTS processed_discharges (
    patient_id     INTEGER NOT NULL,
    discharge_date TEXT    NOT NULL,
    processed_at   TEXT    NOT NULL,
    PRIMARY KEY (patient_id, discharge_date)
  );

  CREATE TABLE IF NOT EXISTS config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// ─── Tabelas para automações Claudia IA ────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS package_reminders (
    package_id TEXT NOT NULL,
    level      INTEGER NOT NULL,
    sent_at    TEXT NOT NULL,
    PRIMARY KEY (package_id, level)
  );

  CREATE TABLE IF NOT EXISTS processed_noshows (
    appointment_id TEXT PRIMARY KEY,
    processed_at   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS processed_completions (
    appointment_id TEXT PRIMARY KEY,
    scheduled_date TEXT NOT NULL,
    processed_at   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sent_birthdays (
    patient_phone TEXT NOT NULL,
    year          INTEGER NOT NULL,
    sent_at       TEXT NOT NULL,
    PRIMARY KEY (patient_phone, year)
  );

  CREATE TABLE IF NOT EXISTS sent_reactivations (
    patient_id   TEXT PRIMARY KEY,
    sent_at      TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notified_completed_packages (
    package_id TEXT PRIMARY KEY,
    sent_at    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sent_referrals (
    patient_phone TEXT PRIMARY KEY,
    sent_at       TEXT NOT NULL
  );

    CREATE TABLE IF NOT EXISTS sent_sameday_reminders (
      appointment_id TEXT PRIMARY KEY,
      sent_at TEXT NOT NULL
    );
`)

db.exec(`
  CREATE TABLE IF NOT EXISTS phone_lid_map (
    lid_jid    TEXT PRIMARY KEY,
    phone      TEXT NOT NULL,
    push_name  TEXT,
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE INDEX IF NOT EXISTS idx_lid_map_phone ON phone_lid_map(phone);
`);;

// ─── Queries preparadas ────────────────────────────────────────────────────────

export const queries = {
  // Pacientes
  getPatientByPhone:  db.prepare(`SELECT * FROM patients WHERE phone = ?`),
  getPatientByContactPhone: db.prepare(`SELECT * FROM patients WHERE contact_phone = ?`),
  getPatientById:     db.prepare(`SELECT * FROM patients WHERE id = ?`),
  getAllPatients:     db.prepare(`SELECT * FROM patients ORDER BY name`),
  getDischargedPatients: db.prepare(`SELECT * FROM patients WHERE status = 'alta_confirmada'`),

  insertPatient: db.prepare(`
    INSERT INTO patients (name, phone, birth_date, contact_phone, email, specialty, first_appointment_date, notes, registration_complete)
    VALUES (@name, @phone, @birth_date, @contact_phone, @email, @specialty, @first_appointment_date, @notes, @registration_complete)
  `),

  updatePatientRegistration: db.prepare(`
    UPDATE patients
    SET name = @name,
        birth_date = @birth_date,
        contact_phone = @contact_phone,
        registration_complete = 1,
        status = 'em_tratamento',
        updated_at = datetime('now','localtime')
    WHERE id = @id
  `),

  updatePatientStatus: db.prepare(`
    UPDATE patients SET status = @status, updated_at = datetime('now','localtime')
    WHERE id = @id
  `),

  confirmDischarge: db.prepare(`
    UPDATE patients
    SET status = 'alta_confirmada',
        discharge_date = @discharge_date,
        updated_at = datetime('now','localtime')
    WHERE id = @id
  `),

  updatePatient: db.prepare(`
    UPDATE patients
    SET name = @name, email = @email, specialty = @specialty, notes = @notes,
        updated_at = datetime('now','localtime')
    WHERE id = @id
  `),

  // Follow-ups
  getPendingFollowups: db.prepare(`
    SELECT f.*, p.name, p.phone
    FROM followups f
    JOIN patients p ON f.patient_id = p.id
    WHERE f.status = 'pendente'
      AND f.scheduled_date <= datetime('now','localtime')
    ORDER BY f.scheduled_date ASC
  `),

  getFollowupsByPatient: db.prepare(`
    SELECT * FROM followups WHERE patient_id = ? ORDER BY scheduled_date ASC
  `),

  insertFollowup: db.prepare(`
    INSERT INTO followups (patient_id, type, scheduled_date)
    VALUES (@patient_id, @type, @scheduled_date)
  `),

  markFollowupSent: db.prepare(`
    UPDATE followups SET status = 'enviado', sent_at = datetime('now','localtime')
    WHERE id = ?
  `),

  markFollowupResponded: db.prepare(`
    UPDATE followups SET status = 'respondido', response = @response
    WHERE id = @id
  `),

  setLgpdConsent: db.prepare(`
    UPDATE patients SET lgpd_consent = 1, updated_at = datetime('now','localtime') WHERE id = ?
  `),

  cancelFollowupsByPatient: db.prepare(`
    UPDATE followups SET status = 'cancelado'
    WHERE patient_id = ? AND status = 'pendente'
  `),

  // Conversas
  getConversationHistory: db.prepare(`
    SELECT role, content FROM conversations
    WHERE patient_id = ?
      AND created_at >= datetime('now', 'localtime', '-48 hours')
    ORDER BY created_at DESC
    LIMIT 20
  `),

  insertMessage: db.prepare(`
    INSERT INTO conversations (patient_id, role, content) VALUES (?, ?, ?)
  `),

  // Log de mensagens
  logMessage: db.prepare(`
    INSERT INTO message_log (phone, direction, content, type) VALUES (?, ?, ?, ?)
  `),

  // LID mapping
  getLidMapping: db.prepare(`SELECT phone, push_name FROM phone_lid_map WHERE lid_jid = ?`),
  upsertLidMapping: db.prepare(`
    INSERT INTO phone_lid_map (lid_jid, phone, push_name, updated_at)
    VALUES (@lid_jid, @phone, @push_name, datetime('now','localtime'))
    ON CONFLICT(lid_jid) DO UPDATE SET
      phone = @phone,
      push_name = COALESCE(@push_name, phone_lid_map.push_name),
      updated_at = datetime('now','localtime')
  `),
  getRecentOutboundPhones: db.prepare(`
    SELECT DISTINCT phone FROM message_log
    WHERE direction = 'outbound'
      AND created_at >= datetime('now', 'localtime', '-5 minutes')
    ORDER BY created_at DESC
  `),
};


export default db;
