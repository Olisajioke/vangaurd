import mysql from "mysql2/promise"

const db = mysql.createPool({
  host: "localhost",
  user: "root",
  password: "Olisajiokem@@7",   // MySQL password
  database: "vanguard"
})

export default db
