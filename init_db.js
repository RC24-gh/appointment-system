const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./database.db');

db.serialize(() => {
  db.run(`PRAGMA foreign_keys = ON;`);

  // 1. Users Table (with phone and created_at)
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      user_id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT CHECK(role IN ('PATIENT', 'DOCTOR', 'ADMIN')) NOT NULL,
      phone TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 2. Doctor Profiles Table
  db.run(`
    CREATE TABLE IF NOT EXISTS doctor_profiles (
      doctor_id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER UNIQUE REFERENCES users(user_id) ON DELETE CASCADE,
      specialization TEXT NOT NULL,
      consultation_fee REAL NOT NULL,
      is_approved INTEGER DEFAULT 0
    )
  `);

  // 3. Appointments Table (with time_slot and created_at)
  db.run(`
    CREATE TABLE IF NOT EXISTS appointments (
      appointment_id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id INTEGER REFERENCES users(user_id) ON DELETE CASCADE,
      doctor_id INTEGER REFERENCES doctor_profiles(doctor_id) ON DELETE CASCADE,
      appointment_date TEXT NOT NULL,
      time_slot TEXT NOT NULL,
      status TEXT CHECK(status IN ('PENDING', 'CONFIRMED', 'COMPLETED', 'CANCELLED')) DEFAULT 'PENDING',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 4. Payments Table (with doctor_id, payment_status, transaction_date)
  db.run(`
    CREATE TABLE IF NOT EXISTS payments (
      payment_id INTEGER PRIMARY KEY AUTOINCREMENT,
      appointment_id INTEGER UNIQUE REFERENCES appointments(appointment_id) ON DELETE CASCADE,
      doctor_id INTEGER REFERENCES doctor_profiles(doctor_id) ON DELETE CASCADE,
      amount REAL NOT NULL,
      payment_status TEXT CHECK(payment_status IN ('PAID', 'REFUNDED')) DEFAULT 'PAID',
      transaction_date DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  console.log("Database initialized with complete schema!");
});

db.close();