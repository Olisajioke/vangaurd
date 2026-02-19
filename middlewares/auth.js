//requireLogin Function

export function requireLogin(req, res, next) {
  if (!req.session?.userId) {
    req.session.returnTo = req.originalUrl
    return res.redirect("/login")
  }
  next()
}

