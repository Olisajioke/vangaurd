
import db from "../db.js";




// ADMIN function
export function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.redirect("/login")

  db.query("SELECT role FROM users WHERE id=?", [req.session.userId])
    .then(([rows]) => {
      if (!rows[0] || rows[0].role !== "admin") {
        return res.status(403).send("Admins only")
      }
      next()
    })
    .catch(() => res.sendStatus(500))
}