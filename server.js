const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static('public'));

const db = new sqlite3.Database('./database.db', (err) => {
  if (err) console.error(err.message);
  console.log('Connected to SQLite database.');
});

// Auto-create database tables on server start if database.db doesn't exist
db.serialize(() => {
  db.run(`PRAGMA foreign_keys = ON;`);
  
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

  db.run(`
    CREATE TABLE IF NOT EXISTS doctor_profiles (
      doctor_id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER UNIQUE REFERENCES users(user_id) ON DELETE CASCADE,
      specialization TEXT NOT NULL,
      consultation_fee REAL NOT NULL,
      is_approved INTEGER DEFAULT 0
    )
  `);

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
});
const JWT_SECRET = 'your_secret_key';

// JWT Role Authentication Middleware
const authenticateRole = (roles) => {
  return (req, res, next) => {
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ message: 'Access token missing' });

    try {
      const token = authHeader.split(' ')[1];
      const decoded = jwt.verify(token, JWT_SECRET);
      if (!roles.includes(decoded.role)) {
        return res.status(403).json({ message: 'Unauthorized role access' });
      }
      req.user = decoded;
      next();
    } catch (err) {
      res.status(400).json({ message: 'Invalid or expired token' });
    }
  };
};

// --- AUTHENTICATION & REGISTRATION ---
app.post('/api/register', async (req, res) => {
  const { full_name, email, password, role, phone, specialization, consultation_fee } = req.body;
  const hashedPassword = await bcrypt.hash(password, 10);

  db.run(
    `INSERT INTO users (full_name, email, password, role, phone) VALUES (?, ?, ?, ?, ?)`,
    [full_name, email, hashedPassword, role, phone || null],
    function (err) {
      if (err) return res.status(400).json({ error: err.message });
      const newUserId = this.lastID;

      // If registered as DOCTOR, automatically create doctor_profile
      if (role === 'DOCTOR') {
        db.run(
          `INSERT INTO doctor_profiles (user_id, specialization, consultation_fee, is_approved) VALUES (?, ?, ?, 1)`,
          [newUserId, specialization || 'General Physician', consultation_fee || 100],
          function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: 'Doctor account and profile created successfully!' });
          }
        );
      } else {
        res.json({ message: 'User registered successfully!' });
      }
    }
  );
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  db.get(`SELECT * FROM users WHERE email = ?`, [email], async (err, user) => {
    if (err || !user) return res.status(400).json({ message: 'User not found' });

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) return res.status(400).json({ message: 'Invalid credentials' });

    const token = jwt.sign({ userId: user.user_id, role: user.role, name: user.full_name }, JWT_SECRET);
    res.json({ token, role: user.role, name: user.full_name });
  });
});

// Get public list of approved doctors for patient booking dropdown
app.get('/api/public/doctors', (req, res) => {
  const query = `
    SELECT dp.doctor_id, u.full_name, dp.specialization, dp.consultation_fee 
    FROM doctor_profiles dp 
    JOIN users u ON dp.user_id = u.user_id 
    WHERE dp.is_approved = 1
  `;
  db.all(query, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ doctors: rows });
  });
});

// --- PATIENT ROUTE (Prevent Duplicate Booking & Double Payment) ---
app.post('/api/appointments/book', authenticateRole(['PATIENT']), (req, res) => {
  const { doctor_id, appointment_date, time_slot } = req.body;
  const patient_id = req.user.userId;

  // 1. Check if the slot is already booked for this doctor
  db.get(
    `SELECT * FROM appointments WHERE doctor_id = ? AND appointment_date = ? AND time_slot = ? AND status != 'CANCELLED'`,
    [doctor_id, appointment_date, time_slot],
    (err, existingAppt) => {
      if (err) return res.status(500).json({ error: err.message });
      if (existingAppt) {
        return res.status(400).json({ message: 'This time slot is already booked! Please select another time or date.' });
      }

      // 2. Insert appointment if slot is available
      db.run(
        `INSERT INTO appointments (patient_id, doctor_id, appointment_date, time_slot) VALUES (?, ?, ?, ?)`,
        [patient_id, doctor_id, appointment_date, time_slot],
        function (err) {
          if (err) return res.status(500).json({ error: err.message });
          const appointment_id = this.lastID;

          // 3. Create payment record once
          db.get(`SELECT consultation_fee FROM doctor_profiles WHERE doctor_id = ?`, [doctor_id], (err, doc) => {
            const fee = doc ? doc.consultation_fee : 500.00;
            db.run(
              `INSERT INTO payments (appointment_id, doctor_id, amount, payment_status) VALUES (?, ?, ?, 'PAID')`,
              [appointment_id, doctor_id, fee],
              (err) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ message: 'Appointment booked & payment recorded successfully!' });
              }
            );
          });
        }
      );
    }
  );
});

// --- DOCTOR ROUTES (View Dashboard & Update Status) ---
app.get('/api/doctor/dashboard', authenticateRole(['DOCTOR']), (req, res) => {
  const doctorUserId = req.user.userId;

  const query = `
    SELECT 
      a.appointment_id, 
      u.full_name AS patient_name, 
      u.phone AS patient_phone,
      a.appointment_date, 
      a.time_slot, 
      a.status, 
      p.amount,
      p.payment_status
    FROM appointments a
    JOIN users u ON a.patient_id = u.user_id
    LEFT JOIN payments p ON a.appointment_id = p.appointment_id
    WHERE a.doctor_id = (SELECT doctor_id FROM doctor_profiles WHERE user_id = ?)
  `;

  db.all(query, [doctorUserId], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const totalEarnings = rows.reduce((sum, item) => sum + (item.amount || 0), 0);
    res.json({ appointments: rows, totalEarnings });
  });
});

// New Endpoint: Update Appointment Status
app.put('/api/doctor/appointment/status', authenticateRole(['DOCTOR']), (req, res) => {
  const { appointment_id, status } = req.body;

  db.run(
    `UPDATE appointments SET status = ? WHERE appointment_id = ?`,
    [status, appointment_id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ message: `Appointment status updated to ${status}` });
    }
  );
});

// --- ADMIN ROUTES ---
app.get('/api/admin/doctors', authenticateRole(['ADMIN']), (req, res) => {
  const query = `
    SELECT 
      dp.doctor_id, 
      u.full_name, 
      u.email, 
      u.phone, 
      dp.specialization, 
      dp.consultation_fee, 
      dp.is_approved 
    FROM doctor_profiles dp
    JOIN users u ON dp.user_id = u.user_id
  `;
  db.all(query, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ doctors: rows });
  });
});

app.listen(3000, () => console.log('Server running on http://localhost:3000'));