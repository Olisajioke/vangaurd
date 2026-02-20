import express from "express";
import bodyParser from "body-parser";
import session from "express-session";
import flash from "connect-flash";
import multer from "multer";
import methodOverride from "method-override"
import bcrypt from "bcrypt";
import db from "./db.js"
import nodemailer from "nodemailer";
import dotenv from "dotenv"
import path from "path"
import crypto from "crypto"
import resourcesRouter from "./routes/resources.js";
import { requireLogin } from "./middlewares/auth.js";
import { requireAdmin } from "./middlewares/adminrequired.js";





// 🔎 TEST DB CONNECTION
async function testDB() {
  try {
    const [rows] = await db.query("SELECT DATABASE() AS db")
    console.log("Connected to DB:", rows[0].db)
  } catch (err) {
    console.error("DB error:", err.message)
  }
}

testDB()



// HELPER FUNCTION TO CALCULATE AGE
function calculateAge(dob) {
    if (!dob) return null;
    const birth = new Date(dob);
    const today = new Date();

    let age = today.getFullYear() - birth.getFullYear();
    const m = today.getMonth() - birth.getMonth();

    if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) {
      age--;
    }

    return age;
  }

//CONSTANTS
const app = express();
const port = 3000;

dotenv.config()


// session configuration
const sessionConfig = {
  secret: process.env.SESSION_SECRET,   // ← move secret to .env
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    secure: false,   // ← dev: false (localhost is not HTTPS)
    maxAge: 1000 * 60 * 20
  }
};

app.use(session(sessionConfig));


// Flash middleware
app.use(session(sessionConfig))
app.use(flash())


// =========================
// STATIC + PARSING
// =========================
app.use(express.static("public"));
app.use("/uploads", express.static("uploads"));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride("_method"));

// =========================
// SESSION + FLASH
// =========================
app.use(session(sessionConfig));
app.use(flash());

// expose flash to templates
app.use((req, res, next) => {
  res.locals.success = req.flash("success");
  res.locals.error = req.flash("error");
  next();
});

// =========================
// GLOBAL USER INFO
// =========================
app.use(async (req, res, next) => {
  try {
    res.locals.userId = req.session?.userId || null;
    res.locals.userRole = null;
    res.locals.userName = null;

    if (req.session?.userId) {
      const [[user]] = await db.query(
        "SELECT fname, role FROM users WHERE id=?",
        [req.session.userId]
      );

      if (user) {
        res.locals.userRole = user.role;
        res.locals.userName = user.fname;
      }
    }

    next();
  } catch (err) {
    console.error("User middleware error:", err);
    next();
  }
});

// =========================
// NOTICES
// =========================
app.use(async (req, res, next) => {
  try {
    if (req.session?.userId) {
      const [rows] = await db.query(`
        SELECT *
        FROM notices
        WHERE is_active = 1
        AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY created_at DESC
        LIMIT 1
      `);

      res.locals.popupNotice = rows[0] || null;
    } else {
      res.locals.popupNotice = null;
    }

    next();
  } catch {
    res.locals.popupNotice = null;
    next();
  }
});

// =========================
// DB IN TEMPLATES
// =========================
app.use((req, res, next) => {
  res.locals.db = db;
  next();
});

// =========================
// VIEW ENGINE
// =========================
app.set("view engine", "ejs");

// =========================
// MULTER (UPLOADS)
// =========================
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "public/uploads");
  },
  filename: (req, file, cb) => {
    const unique = Date.now() + "-" + file.originalname;
    cb(null, unique);
  }
});

const upload = multer({ storage });

// ckeditor upload
app.post("/upload-review-image", upload.single("upload"), (req, res) => {
  const url = "/uploads/" + req.file.filename;

  res.json({
    uploaded: 1,
    fileName: req.file.filename,
    url
  });
});


// Email transponder setup
const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.ADMIN_EMAIL,
      pass: process.env.ADMIN_EMAIL_PASS
    }
  });

// function to convert empty strings to null for numeric fields
function normalizePatientData(data) {
  const numericFields = [
    "sph_od_obj","cyl_od_obj","axis_od_obj",
    "sph_os_obj","cyl_os_obj","axis_os_obj",
    "sph_od_sub","cyl_od_sub","axis_od_sub",
    "sph_os_sub","cyl_os_sub","axis_os_sub",
    "add_od","add_os"
  ];

  numericFields.forEach(f => {
    if (data[f] === "" || data[f] === undefined) {
      data[f] = null;
    }
  });

  if (data.date_of_birth === "") {
    data.date_of_birth = null;
  }

  return data;
}

// function to convert multi-select arrays to comma-separated strings
function normalizeMultiSelect(data) {
  ["systemic_condition","ocular_surgery"].forEach(f => {
    if (Array.isArray(data[f])) {
      data[f] = data[f].join(",");
    }
  });
  return data;
}




// =========================
// ROUTES
// =========================
app.use("/resources", resourcesRouter);
// HOME ROUTE
app.get("/", (req, res) => {
  res.render("index")
})


// USER REGISTRATION
// Route to display the add new user form
app.get("/add_new_user", (req, res) => {
    res.render("add_new_user");
});

// route to save new user
app.post("/add_new_user", upload.single("profilepic"), async (req, res) => {
  try {
    const { fName, lName, email, password, location, vanguard } = req.body

    // get current vanguard code from DB
    const [rows] = await db.query(
      "SELECT vanguard_code FROM site_settings WHERE id = 1"
    )

    const currentVanguard = rows[0]?.vanguard_code
    console.log(currentVanguard);
    if (!currentVanguard || vanguard !== currentVanguard) {
      return res.render("add_new_user", { error: "Invalid Vanguard code" })
    }

    if (password !== req.body.confirmPassword) {
      return res.render("add_new_user", { error: "Passwords do not match" })
    }

    const hashedPassword = await bcrypt.hash(password, 10)

    const profilepic = req.file ? req.file.filename : null
    const userId = Date.now().toString()

    await db.query(`
      INSERT INTO users
      (id, fname, lname, email, password, location, profilepic)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      userId,
      fName,
      lName,
      email,
      hashedPassword,
      location,
      profilepic
    ])

    req.session.userId = userId
    res.redirect("/profile")
    
  } catch (err) {
    console.error(err)
    res.send("Registration error")
  }
})


// user page
app.get("/user/:id", requireLogin, async (req, res) => {
  try {
    const { id } = req.params;

    const [[user]] = await db.query(
      "SELECT id, fname, lname, email, location, profilepic FROM users WHERE id = ?",
      [id]
    );

    if (!user) return res.status(404).send("User not found");

    user.fullname = user.fname + " " + user.lname;

    res.render("user", { user });

  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading user");
  }
});



// user login get form
app.get("/login", (req, res) => {
  res.render("login")
})


// LOGIN ROUTE
app.post("/login", async (req, res) => {
  const { email, password } = req.body

  const [[user]] = await db.query(
    "SELECT * FROM users WHERE email=?",
    [email]
  )

  if (!user) return res.render("login", { error: "Invalid credentials" })

  // 🔒 check active FIRST
  if (Number(user.is_active) !== 1) {
    return res.render("login", {
      error: "Sorry but your account has been disabled. Please Contact admin on whatsapp or use the mail below."
    })
  }

  let match = false

  // hashed password
  if (user.password.startsWith("$2")) {
    match = await bcrypt.compare(password, user.password)
  } 
  // legacy plain
  else {
    match = password === user.password

    if (match) {
      const newHash = await bcrypt.hash(password, 10)
      await db.query(
        "UPDATE users SET password=? WHERE id=?",
        [newHash, user.id]
      )
    }
  }
  
  if (!match) 
    return res.render("login", { error: "Invalid credentials" })

  req.session.userId = user.id;
  req.session.role = user.role;

  req.session.save(() => res.redirect("/profile"))
})

// forgot password get form
app.get("/forgot-password", (req, res) => {
  res.render("forgotPassword");
});

//forgot password sendemail
app.post("/forgot-password", async (req, res) => {
  const { email } = req.body;

  const [[user]] = await db.query(
    "SELECT id FROM users WHERE email=?",
    [email]
  );

  if (!user) {
    req.flash("error", "No account with that email");
    return res.redirect("/forgot-password");
  }

  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + 1000 * 60 * 30); // 30 min

  await db.query(
    "UPDATE users SET reset_token=?, reset_expires=? WHERE id=?",
    [token, expires, user.id]
  );

  const resetLink = `http://localhost:3000/reset-password/${token}`;

  await transporter.sendMail({
    to: email,
    subject: "Vanguard Password Reset",
    html: `
      <p>You requested a password reset.</p>
      <p><a href="${resetLink}">Click here to reset your password</a></p>
      <p>This link expires in 30 minutes.</p>
    `
  });

  req.flash("success", "Password reset link sent to your email");
  res.redirect("/login");
});

// enter new password form
app.get("/reset-password/:token", async (req, res) => {
  const { token } = req.params;

  const [[user]] = await db.query(
    "SELECT id FROM users WHERE reset_token=? AND reset_expires > NOW()",
    [token]
  );

  if (!user) {
    req.flash("error", "Reset link invalid or expired");
    return res.redirect("/forgot-password");
  }

  res.render("resetPassword", { token });
});

//save new password
app.post("/reset-password/:token", async (req, res) => {
  const { token } = req.params
  const { password, confirm_password } = req.body

  if (password !== confirm_password) {
    req.flash("error", "Passwords do not match")
    return res.redirect(`/reset-password/${token}`)
  }

  const [[user]] = await db.query(
    "SELECT id FROM users WHERE reset_token=? AND reset_expires > NOW()",
    [token]
  )

  if (!user) {
    req.flash("error", "Reset link invalid or expired")
    return res.redirect("/forgot-password")
  }

  const hash = await bcrypt.hash(password, 10)

  await db.query(
    "UPDATE users SET password=?, reset_token=NULL, reset_expires=NULL WHERE id=?",
    [hash, user.id]
  )

  req.flash("success", "Password updated successfully")
  res.redirect("/login")
})



// delete user  
app.post("/user/delete/:id", requireLogin, async (req, res) => {
  const { id } = req.params

  await db.query("DELETE FROM users WHERE id=?", [id])

  req.session.destroy()

  res.redirect("/")
})


//profile page
app.get("/profile", requireLogin, async (req, res) => {

  try {
    const userId = req.session.userId;

    // USER
    const [[user]] = await db.query(
      `SELECT id, fname, lname, email, location, profilepic, role, created_at
       FROM users
       WHERE id=?`,
      [userId]
    );

    if (!user) return res.redirect("/login");

    // POSTS COUNT
    const [[postCount]] = await db.query(
      `SELECT COUNT(*) AS count
       FROM posts
       WHERE user_id=?`,
      [userId]
    );

    // SAVED COUNT
    const [[savedCount]] = await db.query(
      `SELECT COUNT(*) AS count
       FROM saved_items
       WHERE user_id=?`,
      [userId]
    );

    // ARTICLES COUNT
    let articleCount = 0;
    try {
      const [[a]] = await db.query(
        `SELECT COUNT(*) AS count
         FROM posts
         WHERE user_id=? AND type='article'`,
        [userId]
      );
      articleCount = a.count;
    } catch {}

    // RELATIONSHIP COUNT
    let relCount = 0;
    try {
      const [[r]] = await db.query(
        `SELECT COUNT(*) AS count
         FROM relationship_profiles
         WHERE user_id=?`,
        [userId]
      );
      relCount = r.count;
    } catch {}

    // PATIENT COUNT
    let patientCount = 0;
    try {
      const [[p]] = await db.query(
        `SELECT COUNT(*) AS count
         FROM patients
         WHERE doctor_id=?`,
        [userId]
      );
      patientCount = p.count;
    } catch {}

    // ACTIVE NOTICES
  let activeNotices = [];
  console.log("PROFILE SESSION:", req.session)

  try {
      const [rows] = await db.query(`
    SELECT id, title, message
    FROM notices
    WHERE is_active = 1
      AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY created_at DESC
  `);

    activeNotices = rows;
  } catch (e) {
    console.log("Notice load error", e);
  }


    res.render("profile", {
    user,
    stats: {
      posts: postCount.count,
      saved: savedCount.count,
      relationships: relCount,
      articles: articleCount,
      patients: patientCount
    },
    activeNotices
  });


  } catch (err) {
    console.error("PROFILE ERROR →", err);
    res.send("Profile load error");
  }
});

// EDIT USER WITH DB
app.put("/edituser/:id", requireLogin, upload.single("profilepic"), async (req, res) => {
  try {
    const userId = req.params.id
    const { fName, lName, email, location, password, removePhoto } = req.body

    const fields = []
    const values = []

    if (fName) {
      fields.push("fname=?")
      values.push(fName)
    }

    if (lName) {
      fields.push("lname=?")
      values.push(lName)
    }

    if (email) {
      fields.push("email=?")
      values.push(email)
    }

    if (location) {
      fields.push("location=?")
      values.push(location)
    }

    // password change

    if (password && password !== "") {
      if (password !== req.body.confirmPassword) {
        return res.send("Passwords do not match")
      }

      const hash = await bcrypt.hash(password, 10)
      fields.push("password=?")
      values.push(hash)
    }


    // remove photo
    if (removePhoto) {
      fields.push("profilepic=NULL")
    }

    // new upload
    if (req.file) {
      fields.push("profilepic=?")
      values.push(req.file.filename)
    }

    if (fields.length > 0) {
      values.push(userId)
      await db.query(
        `UPDATE users SET ${fields.join(", ")} WHERE id=?`,
        values
      )
    }
    req.flash("success", "Profile updated successfully!");
    res.redirect("/profile")
  } catch (err) {
    console.error(err)
    res.send("Update failed")
  }
})

// DELETE USER
app.delete("/deleteuser/:id", requireLogin, async (req, res) => {
  const { id } = req.params

  await db.query("DELETE FROM users WHERE id=?", [id])

  req.session.destroy(() => {
    req.flash("success", "Profiled deleted successfully");
    res.redirect("/")
  })
})

// Logout route
app.post("/logout", requireLogin, (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login")
  })
})




/// ARTICLES AND COMMENT ROUTES
///ARTICLES ROUTES

// GET all articles
app.get("/articles", requireLogin, async (req, res) => {
  const [articles] = await db.query(`
    SELECT p.id, p.title, p.subtitle, p.content,
           p.image1 AS image, p.created_at,
           u.fname, u.lname
    FROM posts p
    LEFT JOIN users u ON p.user_id = u.id
    WHERE p.type='article'
    ORDER BY p.created_at DESC
  `)
  const isAdmin = req.session.role === "admin";
  res.render("articles", { posts: articles, isAdmin })
})



// Route to create a new post or edit an existing one
app.get("/new_clinic_stories", requireLogin, async (req, res) => {
  const postId = req.query.id
  const isEdit = req.query.mode === "edit"

  let post = null

  if (isEdit && postId) {
    const [[row]] = await db.query(
      "SELECT * FROM posts WHERE id=? AND type='article'",
      [postId]
    )
    post = row
  }

  res.render("create_post", { post, isEdit })
})



// Handle form submission for creating or editing a post
app.post("/submit_story", requireLogin, upload.single("image"), async (req, res) => {
  const { title, subtitle, content, postId } = req.body
  const userId = req.session.userId
  const image = req.file ? req.file.filename : null

  try {

    if (postId) {
      // EDIT
      if (image) {
        await db.query(`
          UPDATE posts
          SET title=?, subtitle=?, content=?, image1=?
          WHERE id=? AND type='article'
        `, [title, subtitle, content, image, postId])
      } else {
        await db.query(`
          UPDATE posts
          SET title=?, subtitle=?, content=?
          WHERE id=? AND type='article'
        `, [title, subtitle, content, postId])
      }
      req.flash("success", "Post edited successfully");
      res.redirect(`/view_posts/${postId}`)

    } else {
      // CREATE
      const newId = Date.now().toString()

      await db.query(`
        INSERT INTO posts
        (id, user_id, type, title, subtitle, content, image1)
        VALUES (?, ?, 'article', ?, ?, ?, ?)
      `, [newId, userId, title, subtitle, content, image])
      req.flash("success", "Story created successfully!");
      res.redirect(`/view_posts/${newId}`)
    }

  } catch (err) {
    req.flash("error", "Error saving story, try again");
    res.send("Article save error")
  }
})


// View a single post
app.get("/view_posts/:id", requireLogin, async (req, res) => {
  const { id } = req.params;

  const [[post]] = await db.query(`
    SELECT p.*, u.fname, u.lname
    FROM posts p
    LEFT JOIN users u ON p.user_id = u.id
    WHERE p.id=? AND p.type='article'
  `, [id]);

  if (!post) return res.status(404).send("Post not found");

  const [comments] = await db.query(`
    SELECT c.id, c.content, c.created_at, c.user_id, u.fname
    FROM comments c
    LEFT JOIN users u ON c.user_id = u.id
    WHERE c.post_id=?
    ORDER BY c.created_at ASC
  `, [id]);
  
  res.render("view_post", {
    post,
    comments,
    currentUserId: req.session.userId,
    isAdmin: req.session.role === "admin",
    editCommentId: req.query.edit
  });
});



// add comments
app.post("/posts/:id/comments", requireLogin, async (req, res) => {
  const postId = parseInt(req.params.id);

  const [[post]] = await db.query(
    "SELECT id FROM posts WHERE id=?",
    [postId]
  );

  if (!post) return res.status(404).send("Post not found");

  const { comment } = req.body;

  await db.query(
    "INSERT INTO comments (post_id, user_id, content) VALUES (?, ?, ?)",
    [postId, req.session.userId, comment]
  );

  req.flash("success", "Comment created successfully");
  res.redirect("/view_posts/" + postId);
});


//EDIT COMMENT

app.put("/posts/:postId/comments/:commentId/edit", requireLogin, async (req, res) => {
  const { postId, commentId } = req.params;
  const { comment } = req.body;   

  await db.query(`
    UPDATE comments
    SET content = ?
    WHERE id = ?
  `, [comment, commentId]);
     req.flash("success", "comment edited successfully");
  res.redirect("/view_posts/" + postId);
});


// Delete a post
app.post("/delete_post/:id", requireLogin, async (req, res) => {
  const { id } = req.params

  await db.query("DELETE FROM comments WHERE post_id=?", [id])
  await db.query("DELETE FROM posts WHERE id=?", [id])
  req.flash("success", "Post deleted successfully");
  res.redirect("/articles")
})


// Delete Comment
app.delete("/posts/:postId/comments/:commentId/delete", requireLogin, async (req, res) => {
  const { postId, commentId } = req.params

  await db.query(
    "DELETE FROM comments WHERE id=? AND post_id=?",
    [commentId, postId]
  )
  req.flash("success", "Comment deleted successfully")
  res.redirect("/view_posts/" + postId);
})



                  /// JOBS

// route to display jobs
app.get("/showjobs", requireLogin, async (req, res) => {
  const [rows] = await db.query(`
    SELECT 
      p.id,
      p.title,
      p.location,
      p.contact,
      j.clinic,
      j.salary,
      j.description,
      j.user_id
    FROM posts p
    JOIN jobs j ON p.id = j.post_id
    ORDER BY p.created_at DESC
  `)

  res.render("showjobs", {
    jobs: rows,
    currentUserId: req.session.userId,
    isAdmin: req.session.role === "admin"
  })
})


// GET A SINGLE JOB
app.get("/jobs/:id", requireLogin, async (req, res) => {
  const { id } = req.params;

  const [[job]] = await db.query(`
    SELECT 
      j.post_id AS id,
      p.title,
      j.clinic,
      j.salary,
      j.description,
      j.location,
      j.contact,
      j.user_id,
      u.fname,
      u.lname
    FROM jobs j
    JOIN posts p ON j.post_id = p.id
    LEFT JOIN users u ON j.user_id = u.id
    WHERE j.post_id = ?
  `, [id]);

  if (!job) return res.status(404).send("Job not found");

  const currentUserId = req.session.userId;
  const isOwner = job.user_id === currentUserId;
  const isAdmin = req.session.role === "admin";

  res.render("singlejob", {
    job,
    isOwner,
    isAdmin,
    currentUserId
  });
});



// route to create job
app.post("/createJobs", requireLogin, async (req, res) => {
  const { clinic, location, salary, contact, description, title } = req.body;

  const userId = req.session.userId;
  const postId = Date.now().toString(); // shared ID

  // insert into posts
  await db.query(`
    INSERT INTO posts
    (id, user_id, type, title, location, contact)
    VALUES (?, ?, 'job', ?, ?, ?)
  `, [postId, userId, title, location, contact]);

  // insert into jobs
  await db.query(`
    INSERT INTO jobs
    (post_id, user_id, clinic, salary, description, location, contact)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [
    postId,
    userId,
    clinic,
    salary,
    description,
    location,
    contact
  ]);
  req.flash("success", "Job added successfully!");
  res.redirect("/showjobs");
});



//EDIT JOBS
app.put("/editjob/:id", requireLogin, async (req, res) => {
  const { id } = req.params;
  const { title, clinic, location, salary, contact, description } = req.body;

  // update posts
  await db.query(`
    UPDATE posts
    SET title=?, location=?, contact=?
    WHERE id=?
  `, [title, location, contact, id]);

  // update jobs
  await db.query(`
    UPDATE jobs
    SET clinic=?, salary=?, description=?, location=?, contact=?
    WHERE post_id=?
  `, [clinic, salary, description, location, contact, id]);
    req.flash("success", "Job edited successfully!");

  res.redirect("/showjobs");
});


//delete jobs
app.delete("/deletejob/:id", requireLogin, async (req, res) => {
  const { id } = req.params;

  // load job owner
  const [[job]] = await db.query(
    "SELECT user_id FROM jobs WHERE post_id=?",
    [id]
  );

  if (!job) return res.status(404).send("Job not found");

  // 🔐 ownership / admin check
  if (job.user_id !== req.session.userId && req.session.role !== "admin") {
    return res.status(403).send("Not authorized");
  }

  // delete job + linked post
  await db.query("DELETE FROM jobs WHERE post_id=?", [id]);
  await db.query("DELETE FROM posts WHERE id=?", [id]);
  req.flash("success", "Job Detail deleted successfully!");

  res.redirect("/showjobs");
});



              /// MARKET PLACE

// show all items for sale
app.get("/market", requireLogin, async (req, res) => {
  const userId = req.session.userId

  const [items] = await db.query(`
    SELECT p.id, p.user_id, p.title, p.content AS description,
           p.location, p.contact,
           p.image1, p.image2, p.image3,
           m.price
    FROM posts p
    JOIN market_items m ON p.id = m.post_id
    ORDER BY p.created_at DESC
  `)

  const [saved] = await db.query(
    "SELECT post_id FROM saved_items WHERE user_id=?",
    [userId]
  )

  const savedIds = saved.map(s => s.post_id)
  const isAdmin = req.session.role === "admin";
  res.render("market", { items, savedIds, userId, isAdmin })
})



// get a single item
app.get("/item/:id", requireLogin, async (req, res) => {
  const { id } = req.params
  const userId = req.session.userId

  const [[item]] = await db.query(`
    SELECT 
      p.id,
      p.title,
      p.content AS description,
      p.location,
      p.contact,
      p.image1,
      p.image2,
      p.image3,
      u.fname,
      u.lname,
      m.price,
      m.condition_note
    FROM posts p
    JOIN market_items m ON p.id = m.post_id
    LEFT JOIN users u ON p.user_id = u.id
    WHERE p.id = ?
  `, [id])

  if (!item) return res.status(404).send("Item not found")

  // build gallery
  item.images = [item.image1, item.image2, item.image3].filter(Boolean)

  // seller display
  item.seller = [item.fname, item.lname].filter(Boolean).join(" ") || "Unknown"

  // saved check
  const [savedRows] = await db.query(
    "SELECT 1 FROM saved_items WHERE user_id=? AND post_id=?",
    [userId, id]
  )
  const isSaved = savedRows.length > 0;
  const isAdmin = req.session.role === "admin";
  const currentUserId = req.sessionID;

  res.render("item", { item, isSaved, isAdmin, currentUserId })
})




// create item for sale
app.post("/createitem", requireLogin, upload.array("images", 3), async (req, res) => {
  try {
    const { title, price, description, location, contact, condition_note } = req.body
    const userId = req.session.userId
    const postId = Date.now().toString()

    const files = req.files || []
    const image1 = files[0]?.filename || null
    const image2 = files[1]?.filename || null
    const image3 = files[2]?.filename || null

    await db.query(`
      INSERT INTO posts
      (id, user_id, type, title, content, location, contact, image1, image2, image3)
      VALUES (?, ?, 'market', ?, ?, ?, ?, ?, ?, ?)
    `, [
      postId,
      userId,
      title,
      description,
      location,
      contact,
      image1,
      image2,
      image3
    ])

    await db.query(`
      INSERT INTO market_items (post_id, price, condition_note)
      VALUES (?, ?, ?)
    `, [postId, price, condition_note])

    req.flash("success", "Item created successfully")
    res.redirect("/market")

  } catch (err) {
    console.error(err)
    req.flash("error", "Error creating item")
    res.redirect("/market")
  }
})


// EDIT ITEM AND UPDATE
app.put("/edititem/:id", requireLogin, upload.array("images", 3), async (req, res) => {
  const { id } = req.params;
  const { title, price, description, location, contact, condition_note } = req.body;

  const files = req.files || [];
  let image1 = null, image2 = null, image3 = null;

  if (files.length > 0) {
    image1 = files[0]?.filename || null;
    image2 = files[1]?.filename || null;
    image3 = files[2]?.filename || null;
  }

  if (files.length > 0) {
    await db.query(`
      UPDATE posts
      SET title=?, content=COALESCE(?, content), location=?, contact=?,
          image1=?, image2=?, image3=?
      WHERE id=?
    `, [title, description, location, contact, image1, image2, image3, id]);
  } else {
    await db.query(`
      UPDATE posts
      SET title=?, content=COALESCE(?, content), location=?, contact=?
      WHERE id=?
    `, [title, description, location, contact, id]);
  }

  await db.query(`
    UPDATE market_items
    SET price=?, condition_note=?
    WHERE post_id=?
  `, [price, condition_note, id]);

  req.flash("success", "Item updated successfully");
  res.redirect("/market");
});



// delete item

app.delete("/deleteitem/:id", requireLogin, async (req, res) => {
  const { id } = req.params

  await db.query("DELETE FROM market_items WHERE post_id=?", [id])
  await db.query("DELETE FROM posts WHERE id=?", [id])
  req.flash("success", "Item deleted successfully!")

  res.redirect("/market");
})


// SAVED LIST
app.post("/toggle-save/:id", requireLogin, async (req, res) => {
  const userId = req.session.userId
  const { id } = req.params

  const [[exists]] = await db.query(
    "SELECT * FROM saved_items WHERE user_id=? AND post_id=?",
    [userId, id]
  )

  if (exists) {
    await db.query(
      "DELETE FROM saved_items WHERE user_id=? AND post_id=?",
      [userId, id]
    )
    req.flash("success", "Item successefully removed from cart!");
  } else {
    await db.query(
      "INSERT INTO saved_items (user_id, post_id) VALUES (?, ?)",
      [userId, id]
    )
    req.flash("success", "Item successefully added to cart!");
  }
  
  res.redirect("/market")   
})


// SAVED ITEMS PAGE
app.get("/saved", requireLogin, async (req, res) => {
  const userId = req.session.userId

  const [items] = await db.query(`
    SELECT p.id, p.title, p.content AS description,
           p.location, p.contact,
           p.image1, p.image2, p.image3,
           m.price
    FROM saved_items s
    JOIN posts p ON s.post_id = p.id
    JOIN market_items m ON p.id = m.post_id
    WHERE s.user_id = ?
    ORDER BY s.created_at DESC
  `, [userId])
  res.render("saved", { items })
})



// RELATIONSHIPS:

// get relationship form
app.get("/relationships/new", requireLogin, (req, res) => {
  res.render("relationshipForm")
})

// show relationships
app.get("/relationships", requireLogin, async (req, res) => {
  const [rows] = await db.query(`
    SELECT p.id AS post_id, r.*
    FROM posts p
    JOIN relationship_profiles r ON p.id = r.post_id
    WHERE p.type = 'relationship'
    ORDER BY p.created_at DESC
  `)
    const isAdmin = req.session.role === "admin";
  res.render("relationships", { relationships: rows, isAdmin})
})

// get one relationship
app.get("/relationships/:id", requireLogin, async (req, res) => {
  const { id } = req.params

  const [[rel]] = await db.query(`
    SELECT p.user_id, r.*
    FROM posts p
    JOIN relationship_profiles r ON p.id = r.post_id
    WHERE p.id = ?
  `, [id])

  const isOwner = req.session.userId === rel.user_id
  const isAdmin = req.session.role === "admin";

  res.render("relationshipView", { rel, isOwner, isAdmin})
})


app.get("/create-relationship", requireLogin, (req, res) => {
  res.render("relationshipForm");
})


// create relationship
app.post(
  "/create-relationship",
  requireLogin,
  upload.array("images", 3),
  async (req, res) => {
    try {
      const {
        name,
        bio,
        city,
        sex,
        looking_for,
        age,
        thought,
        contact
      } = req.body

      const userId = req.session.userId
      const postId = Date.now().toString()

      // extract filenames safely
      const files = req.files || []
      const image1 = files[0]?.filename || null
      const image2 = files[1]?.filename || null
      const image3 = files[2]?.filename || null

      // insert post
      await db.query(
        `INSERT INTO posts (id, user_id, type, title, content, location, contact)
         VALUES (?, ?, 'relationship', ?, ?, ?, ?)`,
        [
          postId,
          userId,
          `Relationship: ${name}`,
          bio,
          city,
          contact
        ]
      )

      // insert relationship profile with images
      await db.query(
        `INSERT INTO relationship_profiles
        (post_id, name, bio, city, sex, looking_for, age, thought, contact, image1, image2, image3)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          postId,
          name,
          bio,
          city,
          sex,
          looking_for,
          age,
          thought,
          contact,
          image1,
          image2,
          image3
        ]
      )
      req.flash("success", "Profile created successfully");
      res.redirect("/relationships");

    } catch (err) {
      req.flash("error", "Relationship insert error:");
      res.send("Error creating relationship profile");
    }
  }
)




// edit relationship
app.post(
  "/relationships/edit/:id",
  requireLogin,
  upload.array("images", 3),
  async (req, res) => {

    const { id } = req.params

    const {
      name,
      bio,
      city,
      sex,
      looking_for,
      age,
      thought,
      contact
    } = req.body

    const [[post]] = await db.query(
      "SELECT user_id FROM posts WHERE id=?",
      [id]
    )

    if (!post || post.user_id !== req.session.userId) {
      return res.redirect("/relationships/" + id)
    }

    // existing images
    const [[existing]] = await db.query(
      "SELECT image1, image2, image3 FROM relationship_profiles WHERE post_id=?",
      [id]
    )

    const files = req.files || []

    const image1 = files[0]?.filename || existing.image1
    const image2 = files[1]?.filename || existing.image2
    const image3 = files[2]?.filename || existing.image3

    await db.query(`
      UPDATE relationship_profiles
      SET name=?, bio=?, city=?, sex=?, looking_for=?, age=?, thought=?, contact=?,
          image1=?, image2=?, image3=?
      WHERE post_id=?
    `, [
      name,
      bio,
      city,
      sex,
      looking_for,
      age,
      thought,
      contact,
      image1,
      image2,
      image3,
      id
    ])
    req.flash("success", "Profile updated Successfully!");
    res.redirect("/relationships/" + id)
  }
)

// delete relationship
app.post("/relationships/delete/:id", requireLogin, async (req, res) => {
  const { id } = req.params

  await db.query("DELETE FROM relationship_profiles WHERE post_id=?", [id])
  await db.query("DELETE FROM posts WHERE id=?", [id])

  req.flash("success", "Profile deleted successfully!");
  res.redirect("/relationships")
})


//CLINIC REVIEWS

// Get Clinic review form
app.get("/reviews/create", requireLogin, (req, res) => {
  res.render("clinicreviewForm")
})


// create reviews
app.post("/reviews/create", requireLogin, async (req, res) => {
  try {
    const { clinic_name, rating, pros, cons, recommendation } = req.body

    const postId = Date.now().toString()
    const userId = req.session.userId

    // base post
    await db.query(
      `INSERT INTO posts (id, user_id, type, title)
       VALUES (?, ?, 'clinic_review', ?)`,
      [postId, userId, clinic_name]
    )

    // clinic review WITH OWNER
    await db.query(
      `INSERT INTO clinic_reviews
       (post_id, user_id, clinic_name, rating, pros, cons, recommendation)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [postId, userId, clinic_name, rating, pros, cons, recommendation]
    )
    req.flash("success", "Review Created Successfully!");
    res.redirect("/reviews/" + postId);

  } catch (err) {
    req.flash("error", "CREATE REVIEW ERROR, TRY AGAIN:")
    res.status(500).send("Error creating review")
  }
})


//  show all reviews
app.get("/reviews", requireLogin, async (req, res) => {
  const { clinic } = req.query;

  let sql = `
    SELECT p.id AS post_id, r.*
    FROM posts p
    JOIN clinic_reviews r ON p.id = r.post_id
  `;

  let params = [];

  if (clinic && clinic.trim() !== "") {
    sql += " WHERE r.clinic_name LIKE ?";
    params.push(`%${clinic}%`);
  }

  sql += " ORDER BY p.created_at DESC";

  const [rows] = await db.query(sql, params);
  const isAdmin = req.session.role === "admin";

  res.render("showallreviews", { isAdmin, 
    reviews: rows,
    query: clinic || ""
  });
});


// single clinic review route
app.get("/reviews/:id", requireLogin, async (req, res) => {
  const { id } = req.params
  const userId = req.session.userId

  // review
  const [[review]] = await db.query(
    "SELECT * FROM clinic_reviews WHERE post_id=?",
    [id]
  )

  // comments + user names
  const [comments] = await db.query(
    `SELECT c.*, u.fname
     FROM comments c
     LEFT JOIN users u ON c.user_id = u.id
     WHERE c.post_id=?
     ORDER BY c.created_at DESC`,
    [id]
  )

  // ⭐ review ownership
  const isOwner = String(review.user_id) === String(userId)
  const isAdmin = req.session.role === "admin";

  // ⭐ comment ownership
  const commentsWithOwner = comments.map(c => ({
    ...c,
    isOwner: String(c.user_id) === String(userId)
  }))

  res.render("singlereviewView", {
    isAdmin,
    review,
    comments: commentsWithOwner,
    isOwner,   // 👈 REQUIRED for review buttons
    userId
  })
})


// EDIT COMMENT
app.post("/reviews/comments/edit/:postId/:commentId", requireLogin, async (req, res) => {
  const { postId, commentId } = req.params
  const { content } = req.body

  await db.query(
    "UPDATE comments SET content=? WHERE id=? AND post_id=?",
    [content, commentId, postId]
  )
  req.flash("success", "Comment edited successfully");

  res.redirect("/reviews/" + postId)
})


// DELETE REVIEW COMMENT
app.post("/reviews/comments/delete/:postId/:commentId", requireLogin, async (req, res) => {
  const { postId, commentId } = req.params

  await db.query(
    "DELETE FROM comments WHERE id=? AND post_id=?",
    [commentId, postId]
  )
  req.flash("success", "Post deleted successfully");
  res.redirect("/reviews/" + postId)
})

//get edit clinic view
app.get("/reviews/edit/:id",requireLogin, async (req, res) => {
  const { id } = req.params

  const [[review]] = await db.query(
    `SELECT * FROM clinic_reviews WHERE post_id=?`,
    [id]
  )

  res.render("reviewEdit", { review })
})

// post edit clinic view
app.post("/reviews/edit/:id", requireLogin, async (req, res) => {
  const { id } = req.params
  const {clinic_name, rating, pros, cons, recommendation } = req.body

  await db.query(
  `UPDATE clinic_reviews
   SET clinic_name=?, rating=?, pros=?, cons=?, recommendation=?
   WHERE post_id=?`,
  [clinic_name, rating, pros, cons, recommendation, id]
  )

  req.flash("success", "Post edited successfully");
  res.redirect("/reviews/" + id)
})

// delete clinic review
app.post("/reviews/delete/:id", requireLogin, async (req,res)=>{
  const { id } = req.params
  await db.query("DELETE FROM clinic_reviews WHERE post_id=?", [id])
  await db.query("DELETE FROM posts WHERE id=?", [id])
  req.flash("success", "Review deleted successfully");
  res.redirect("/reviews")
})


// review comments
app.post("/reviews/comments/add/:reviewId", requireLogin, async (req,res)=>{
  const { reviewId } = req.params
  const { content } = req.body
  const userId = req.session.userId

  await db.query(
    `INSERT INTO comments (post_id, user_id, content)
     VALUES (?, ?, ?)`,
    [reviewId, userId, content]
  )
  req.flash("success", "Comment added successfully");
  res.redirect("/reviews/" + reviewId)

})


// ADMIN DASHBOARD
app.get("/admin", requireAdmin, requireLogin, async (req, res) => {

  const [[counts]] = await db.query(`
    SELECT
      (SELECT COUNT(*) FROM users) AS users,
      (SELECT COUNT(*) FROM posts) AS posts,
      (SELECT COUNT(*) FROM jobs) AS jobs,
      (SELECT COUNT(*) FROM market_items) AS market,
      (SELECT COUNT(*) FROM clinic_reviews) AS reviews,
      (SELECT COUNT(*) FROM notices) AS notices
  `)

  res.render("admin/dashboard", { counts })
})





// MAKE OR REMOVE ADMIN POSITION:
app.post("/admin/users/:id/role", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { currentAdminId } = req.body;

  // prevent self role change
  if (parseInt(id) === parseInt(currentAdminId)) {
    return res.redirect("/admin/users");
  }

  const [rows] = await db.query(
    "SELECT role FROM users WHERE id = ?",
    [id]
  );

  if (!rows.length) return res.redirect("/admin/users");

  const newRole = rows[0].role === "admin" ? "user" : "admin";

  await db.query(
    "UPDATE users SET role = ? WHERE id = ?",
    [newRole, id]
  );
  if (newRole === "admin")
  {
    req.flash("success", "Doctor successfully upgraded to admin")
  } else {
    req.flash("success", "Doctor successfully demoted to user")
  }
  
  res.redirect("/admin/users");
});


//TOGGLE USERS OFF OR ON
app.post("/admin/users/:id/toggle", requireLogin, requireAdmin, async (req, res) => {
  const { id } = req.params;

  // get current state
  const [[user]] = await db.query(
    "SELECT is_active FROM users WHERE id = ?",
    [id]
  );

  if (!user) {
    req.flash("error", "User not found");
    return res.redirect("/admin/users");
  }

  // toggle
  await db.query(
    "UPDATE users SET is_active = NOT is_active WHERE id = ?",
    [id]
  );

  // flash based on previous state
  if (user.is_active) {
    req.flash("success", "User disabled successfully!");
  } else {
    req.flash("success", "User activated successfully!");
  }

  res.redirect("/admin/users");
});



// ADMIN POSTS LIST

app.get("/admin/posts", requireLogin, requireAdmin, async (req, res) => {
  const q = req.query.q || "";

  let sql = `
    SELECT p.id, p.title, p.created_at,
           u.fname, u.lname
    FROM posts p
    JOIN users u ON p.user_id = u.id
  `;

  const params = [];

  if (q) {
    sql += `
      WHERE p.title LIKE ?
         OR p.content LIKE ?
    `;
    params.push(`%${q}%`, `%${q}%`);
  }

  sql += " ORDER BY p.created_at DESC";

  const [posts] = await db.query(sql, params);

  res.render("admin/posts", { posts, q });
});


// SECOND GET FOR ALL POSTS
app.get("/admin/posts", requireLogin, requireAdmin, async (req, res) => {
  const [posts] = await db.query(`
    SELECT p.id, p.title, p.created_at,
           u.fname, u.lname
    FROM posts p
    JOIN users u ON p.user_id = u.id
    ORDER BY p.created_at DESC
  `);

  res.render("admin/posts", { posts });
});


//ADMIN CONTROL:  DELETE POST
app.post("/admin/posts/:id/delete", requireLogin, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);

  // dependent subtype records
  await db.query("DELETE FROM relationship_profiles WHERE post_id = ?", [id]);
  await db.query("DELETE FROM clinic_reviews WHERE post_id = ?", [id]);
  await db.query("DELETE FROM market_items WHERE post_id = ?", [id]);

  // comments depend on posts
  await db.query("DELETE FROM comments WHERE post_id = ?", [id]);

  // now safe to delete post
  await db.query("DELETE FROM posts WHERE id = ?", [id]);

  req.flash("success", "Post deleted successfully");
  res.redirect("/admin/posts");
});




// ADMIN CONTROL: EDIT POST GET
app.get("/admin/posts/:id/edit", requireLogin, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);   // ← important

  const [rows] = await db.query(
    "SELECT id, title, content FROM posts WHERE id = ?",
    [id]
  );

  console.log("EDIT ROW:", rows);

  if (!rows.length) {
    req.flash("error", "Post not found");
    return res.redirect("/admin/posts");
  }

  res.render("admin/editpost", { post: rows[0] });
});



// ADMIN CONTROL: EDIT POST, POST
app.post("/admin/posts/:id/edit", requireLogin, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);

  
  const { title, content } = req.body;

  await db.query(
    "UPDATE posts SET title = ?, content = ? WHERE id = ?",
    [title, content, id]
  );
 

  req.flash("success", "Great job admin, post updated successfully!");
  res.redirect("/admin/posts");
});





//ADMIN GET JOB ROUTE
app.get("/admin/posts/jobs", requireLogin, requireAdmin, async (req, res) => {
  const q = req.query.q || "";

  let sql = `
    SELECT p.id, p.title, p.created_at,
           u.fname, u.lname
    FROM posts p
    JOIN users u ON p.user_id = u.id
    WHERE p.type = 'job'
  `;

  const params = [];

  if (q) {
    sql += " AND (p.title LIKE ? OR p.body LIKE ?)";
    params.push(`%${q}%`, `%${q}%`);
  }

  sql += " ORDER BY p.created_at DESC";

  const [posts] = await db.query(sql, params);

  res.render("admin/posts", { posts, q, type: "job", query: req.query });
});

// flag posts

app.post("/posts/:id/flag", requireLogin, async (req, res) => {
  const { id } = req.params;
  const reason = req.body.reason || null;
  const userId = req.user.id;

  await db.query(
    "UPDATE posts SET flagged = 1, flag_reason = ?, flagged_by = ? WHERE id = ?",
    [reason, userId, id]
  );

  res.redirect("back");
});


//unflag posts
app.post("/admin/posts/:id/unflag", requireAdmin, async (req, res) => {
  await db.query(
    "UPDATE posts SET flagged = 0, flag_reason = NULL, flagged_by = NULL WHERE id = ?",
    [req.params.id]
  );
  res.redirect("back");
});

//SEARCH AND RETURN USERS - ADMIN
app.get("/admin/users", requireAdmin, async (req, res) => {
  const { role, banned, q } = req.query;

  let sql = `
    SELECT id, fname, lname, email, role, is_active, created_at
    FROM users
    WHERE 1=1
  `;
  const params = [];

  if (q) {
    sql += " AND (fname LIKE ? OR lname LIKE ? OR email LIKE ?)";
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }

  if (role === "admin") {
    sql += " AND role = 'admin'";
  }

  if (banned === "1") {
    sql += " AND is_active = 0";
  }

  sql += " ORDER BY created_at DESC";

  const [users] = await db.query(sql, params);

  res.render("admin/users", {
    users,
    query: req.query || {},
    currentAdminId: req.user ? req.user.id : null
  });
});

//GET SINGLE USER
app.get("/admin/users/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;

  const [rows] = await db.query(
    `SELECT id, fname, lname, email, role, is_active, created_at
     FROM users
     WHERE id = ?`,
    [id]
  );

  if (rows.length === 0) {
    return res.status(404).send("User not found");
  }

  const user = rows[0];

  res.render("admin/user-detail", {
    user,
    currentAdminId: req.user.id
  });
});


//get posts
app.get("/admin/posts", requireAdmin, async (req, res) => {
  const { flagged, type, status, q } = req.query;

  let sql = `
    SELECT p.*, u.fname, u.lname
    FROM posts p
    JOIN users u ON p.user_id = u.id
    WHERE 1=1
  `;
  const params = [];

  if (flagged) {
    sql += " AND p.flagged = 1";
  }

  if (type) {
    sql += " AND p.type = ?";
    params.push(type);
  }

  if (status) {
    sql += " AND p.status = ?";
    params.push(status);
  }

  if (q) {
    sql += " AND (p.title LIKE ? OR p.body LIKE ?)";
    params.push(`%${q}%`, `%${q}%`);
  }

  sql += " ORDER BY p.created_at DESC";

  const [posts] = await db.query(sql, params);

  res.render("admin/posts", {
    posts,
    q: q || "",
    type: type || null
  });
});


//ADMIN GET MARKET ROUTE
app.get("/admin/posts/market", requireLogin, requireAdmin, async (req, res) => {
  const q = req.query.q || "";

  let sql = `
    SELECT p.id, p.title, p.created_at,
           u.fname, u.lname
    FROM posts p
    JOIN users u ON p.user_id = u.id
    WHERE p.type = 'market'
  `;

  const params = [];

  if (q) {
    sql += " AND (p.title LIKE ? OR p.body LIKE ?)";
    params.push(`%${q}%`, `%${q}%`);
  }

  sql += " ORDER BY p.created_at DESC";

  const [posts] = await db.query(sql, params);

  res.render("admin/posts", { posts, q, type: "market" });
});

// ADD VANGUARD CODE:
app.get("/admin/vanguard", requireLogin, requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT vanguard_code FROM site_settings WHERE id = 1"
    )

    const currentCode = rows[0]?.vanguard_code

    res.render("admin/admin_vanguard", { currentCode })

  } catch (err) {
    console.error(err)
    res.send("Error loading Vanguard settings")
  }
})


// UPDATE VANGUARD CODE
app.post("/admin/vanguard/update", requireLogin, requireAdmin, async (req, res) => {
  try {
    const { vanguard_code } = req.body

    // update DB first
    await db.query(
      "UPDATE site_settings SET vanguard_code=? WHERE id=1",
      [vanguard_code]
    )

    // send notification email
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.ADMIN_EMAIL,
        pass: process.env.ADMIN_EMAIL_PASS
      }
    })

    await transporter.sendMail({
      from: `"Vanguard Security" <${process.env.ADMIN_EMAIL}>`,
      to: process.env.ADMIN_EMAIL,
      subject: "Vanguard Code Rotated",
      text: `The Vanguard access code has been updated.\n\nNew Code: ${vanguard_code}\n\nTime: ${new Date().toISOString()}`
    })
    req.flash("success", "Vanguard code changed successfully!");
    res.redirect("/admin/vanguard")

  } catch (err) {
    console.error(err)
    res.send("Failed to update Vanguard code")
  }
})

//ADMIN NOTICES

// GET ADMIN NOTICES
app.get("/admin/notices/new", requireLogin, requireAdmin, (req, res) => {
  res.render("admin/new_notice");
});


// POST NOTICES
app.post("/admin/notices", requireLogin, requireAdmin, async (req, res) => {
  const { title, message, duration } = req.body;

  let expiresAt = null;

  if (duration && duration != "0") {
    expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + parseInt(duration));
  }

  await db.query(
    "INSERT INTO notices (title, message, expires_at) VALUES (?, ?, ?)",
    [title, message, expiresAt]
  );
  req.flash("success", "Notice created successfully!")
  res.redirect("/admin");
});

// GET NOTICE PAGE
app.get("/admin/notices", requireLogin, requireAdmin, async (req, res) => {
  const [notices] = await db.query(`
    SELECT * FROM notices
    ORDER BY created_at DESC
  `);

  res.render("admin/notices", { notices });
});

// edit notice
app.get("/admin/notices/:id/edit", requireLogin, requireAdmin, async (req, res) => {
  const [rows] = await db.query(
    "SELECT * FROM notices WHERE id = ?",
    [req.params.id]
  );
  res.render("admin/edit-notice", { notice: rows[0] });
});

app.post("/admin/notices/:id/edit", requireAdmin, requireLogin, async (req, res) => {
  const { title, message, duration } = req.body;

  let expiresAt = null;

  if (duration && duration !== "0") {
    expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + parseInt(duration));
  }

  await db.query(
    "UPDATE notices SET title=?, message=?, expires_at=? WHERE id=?",
    [title, message, expiresAt, req.params.id]
  );
  req.flash("success", "Notice edited successfully!");
  res.redirect("/admin/notices");
});

//DELETE NOTICE

app.post("/admin/notices/:id/delete", requireLogin, requireAdmin, async (req, res) => {
  await db.query(
    "DELETE FROM notices WHERE id=?",
    [req.params.id]
  );
  req.flash("success", "Notice deleted successfully!");
  res.redirect("/admin/notices");
});



// PATIENTS' DATA

// show Patient's Registration form
app.get("/patients/new", requireLogin, (req, res) => {
  res.render("patients/form", { patient: null });
});


// create new patient record
app.post("/patients", requireLogin, async (req, res) => {
  const doctorId = req.session.userId;
  const data = normalizePatientData(req.body);
  normalizeMultiSelect(data);

  await db.query(
    `INSERT INTO patients SET ?`,
    { ...data, doctor_id: doctorId }
  );
  req.flash("success", "Patient's folder created successfully!");
  res.redirect("/patients");
});


// patients list with age calculation
app.get("/patients", requireLogin, async (req, res) => {
  const doctorId = req.session.userId;

  const [patients] = await db.query(
    `SELECT * FROM patients
     WHERE doctor_id=?`,
    [doctorId]
  );

  patients.forEach(p => {
    p.age = calculateAge(p.date_of_birth);
  });

  res.render("patients/list", { patients });
});

// view single patient with age calculation
app.get("/patients/:id", requireLogin, async (req, res) => {
  const doctorId = req.session.userId;
  const id = req.params.id;

  const [rows] = await db.query(
    `SELECT *
     FROM patients
     WHERE patient_id=? AND doctor_id=?`,
    [id, doctorId]
  );

  if (!rows.length) {
    return res.status(404).send("Patient not found");
  }

  const patient = rows[0];

  // calculate age
  patient.age = calculateAge(patient.date_of_birth);

  res.render("patients/view", { patient });
});


// edit patient form
app.get("/patients/:id/edit", requireLogin, async (req, res) => {
  const doctorId = req.session.userId;
  const id = req.params.id;

  const [rows] = await db.query(
    "SELECT * FROM patients WHERE patient_id=? AND doctor_id=?",
    [id, doctorId]
  );

  if (!rows.length) return res.status(404).send("Patient not found");

  res.render("patients/form", { patient: rows[0] });
});




// update patient record
app.post("/patients/:id/update", requireLogin, async (req, res) => {
  const doctorId = req.session.userId;
  const id = req.params.id;

  const data = normalizePatientData(req.body);
  normalizeMultiSelect(data);

  await db.query(
    `UPDATE patients SET ?
    WHERE patient_id=? AND doctor_id=?`,
    [data, id, doctorId]
  );
  req.flash("success", "Patient's details updated successfully!");
  res.redirect("/patients");
});

// delete patient record
app.post("/patients/:id/delete", requireLogin, async (req, res) => {
  const doctorId = req.session.userId;
  const id = req.params.id;

  await db.query(
    `DELETE FROM patients
     WHERE patient_id = ?
     AND doctor_id = ?`,
    [id, doctorId]
  );
  req.flash("success", "Patient's details deleted successfully!");
  res.redirect("/patients");
});


// EMAIL TEST ROUTE
app.post("/contact", async (req, res) => {
  const { Email, Message } = req.body;

  try {
      await transporter.sendMail({
        from: '"Vanguard Contact" <optometristvanguard@gmail.com>',
        replyTo: Email,
        to: "optometristvanguard@gmail.com",
        subject: "New Contact Message",
        text: `From: ${Email}\n\n${Message}`
      });

    res.send("Message sent successfully, go back to the homepage.");
  } catch (err) {
    console.error(err);
    res.send("Error sending message, go back and try again.");
  }
});




app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});