import dotenv from "dotenv";
import mysql from "mysql2/promise"

dotenv.config();
const db = mysql.createPool(process.env.DATABASE_URL);

export default db;
/** 
const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,   // MySQL password
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
  connectionLimit: 10
})

export default db

*/
