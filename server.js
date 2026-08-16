"use strict";

/**
 * Photo Gallery API + static frontend.
 *
 * - Uploads image files to a private S3 bucket (server-side, via the task IAM role).
 * - Stores the description + S3 key as metadata in RDS PostgreSQL.
 * - Serves images through CloudFront (private bucket, OAC-restricted).
 *
 * DB credentials come from the RDS-managed secret (Secrets Manager). The ECS task
 * definition injects DB_USER / DB_PASSWORD as container secrets, so in normal
 * operation we just read env vars. As a fallback (e.g. local runs) we can fetch
 * the secret directly if DB_SECRET_ARN is set and the password env var is absent.
 */

const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const path = require("path");
const { Pool } = require("pg");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");

const PORT = parseInt(process.env.PORT || "3000", 10);
const REGION = process.env.AWS_REGION || "eu-central-1";
const S3_BUCKET = process.env.S3_BUCKET;
const CLOUDFRONT_DOMAIN = process.env.CLOUDFRONT_DOMAIN;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    if (/^image\//.test(file.mimetype)) return cb(null, true);
    cb(new Error("Only image uploads are allowed"));
  },
});

const s3 = new S3Client({ region: REGION });
let pool; // lazily initialized

async function resolveDbCredentials() {
  let user = process.env.DB_USER;
  let password = process.env.DB_PASSWORD;

  // Fallback: pull from Secrets Manager if not injected as container secrets.
  if ((!user || !password) && process.env.DB_SECRET_ARN) {
    const sm = new SecretsManagerClient({ region: REGION });
    const res = await sm.send(
      new GetSecretValueCommand({ SecretId: process.env.DB_SECRET_ARN })
    );
    const secret = JSON.parse(res.SecretString);
    user = user || secret.username;
    password = password || secret.password;
  }
  return { user, password };
}

async function getPool() {
  if (pool) return pool;
  const { user, password } = await resolveDbCredentials();
  pool = new Pool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || "5432", 10),
    database: process.env.DB_NAME || "photogallery",
    user,
    password,
    ssl: { rejectUnauthorized: false }, // RDS uses a managed CA cert
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
  return pool;
}

async function initDb() {
  const p = await getPool();
  await p.query(`
    CREATE TABLE IF NOT EXISTS photos (
      id           SERIAL PRIMARY KEY,
      description  TEXT NOT NULL DEFAULT '',
      s3_key       TEXT NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

function imageUrl(s3Key) {
  return `https://${CLOUDFRONT_DOMAIN}/${s3Key}`;
}

// ---- Health check (used by the ALB target group) ----
app.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));

// ---- List photos ----
app.get("/api/photos", async (_req, res) => {
  try {
    const p = await getPool();
    const { rows } = await p.query(
      "SELECT id, description, s3_key, created_at FROM photos ORDER BY created_at DESC LIMIT 200"
    );
    res.json(
      rows.map((r) => ({
        id: r.id,
        description: r.description,
        url: imageUrl(r.s3_key),
        createdAt: r.created_at,
      }))
    );
  } catch (err) {
    console.error("list error:", err);
    res.status(500).json({ error: "Failed to list photos" });
  }
});

// ---- Upload a photo ----
app.post("/api/photos", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "image file is required" });
    const description = (req.body.description || "").toString().slice(0, 1000);

    const ext = (req.file.originalname.split(".").pop() || "jpg").toLowerCase();
    const key = `photos/${Date.now()}-${crypto.randomBytes(6).toString("hex")}.${ext}`;

    await s3.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
        CacheControl: "public, max-age=31536000, immutable",
      })
    );

    const p = await getPool();
    const { rows } = await p.query(
      "INSERT INTO photos (description, s3_key) VALUES ($1, $2) RETURNING id, created_at",
      [description, key]
    );

    res.status(201).json({
      id: rows[0].id,
      description,
      url: imageUrl(key),
      createdAt: rows[0].created_at,
    });
  } catch (err) {
    console.error("upload error:", err);
    res.status(500).json({ error: "Failed to upload photo" });
  }
});

async function start() {
  try {
    await initDb();
    console.log("Database initialized.");
  } catch (err) {
    // Don't crash the container if the DB is briefly unreachable at boot;
    // /health still returns 200 so the ALB keeps the task in service.
    console.error("DB init failed (will retry on first request):", err.message);
  }
  app.listen(PORT, () => console.log(`Photo gallery listening on :${PORT}`));
}

start();
