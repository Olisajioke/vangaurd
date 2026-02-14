import express from "express";
import bodyParser from "body-parser";
import session from "express-session";
import flash from "connect-flash";
import multer from "multer";
import methodOverride from "method-override"
import bcrypt from "bcrypt";
import db from "./db.js"

import path from "path"

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


//CONSTANTS
const app = express();
const port = 3000;
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "public/uploads")
  },
  filename: (req, file, cb) => {
    const unique = Date.now() + "-" + file.originalname
    cb(null, unique)
  }
})
const upload = multer({ storage })

// RESTRICT USERS:
function requireLogin(req, res, next) {
  if (!req.session.userId) return res.redirect("/login")
  next()
}

app.use(session({
  secret: "keyboard cat",
  resave: false,
  saveUninitialized: false
}));

app.use(async (req, res, next) => {
  try {
    const userId = req.session?.userId;

    if (userId) {
      const [[user]] = await db.query(
        "SELECT fname, role FROM users WHERE id=?",
        [userId]
      );

      res.locals.userName = user?.fname;
      res.locals.userRole = user?.role;
    }

    next();
  } catch (err) {
    console.error("User middleware error:", err);
    next(); // never block request
  }
});



// ADMIN function
function requireAdmin(req, res, next) {
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
// ckeditor upload
app.post("/upload-review-image", upload.single("upload"), (req, res) => {
  const url = "/uploads/" + req.file.filename

  res.json({
    uploaded: 1,
    fileName: req.file.filename,
    url: url
  })
})


app.use((req, res, next) => {
  res.locals.db = db;
  next();
});

// Session middleware (required for flash)
app.use(session({
  secret: 'ExpressSessionMiddleWareKey',  // i have to replace this with a secure key in production
  resave: false,
  saveUninitialized: true
}));

// Flash middleware
app.use(flash());

// Make flash messages available in templates
app.use((req, res, next) => {
  res.locals.success_msg = req.flash('success');
  res.locals.error_msg = req.flash('error');
  next();
});
app.use(express.static("public"));
app.use("/uploads", express.static("uploads"));
app.use(bodyParser.urlencoded({ extended: true }));
app.set("view engine", "ejs");
app.use(methodOverride("_method"))


app.use(async (req, res, next) => {
  try {
    res.locals.userId = req.session?.userId || null
    res.locals.userRole = null
    res.locals.userName = null

    if (req.session?.userId) {
      const [[user]] = await db.query(
        "SELECT fname, role FROM users WHERE id=?",
        [req.session.userId]
      )

      if (user) {
        res.locals.userRole = user.role
        res.locals.userName = user.fname
      }
    }

    next()
  } catch (err) {
    console.error("locals middleware error:", err)
    next()
  }
})


app.use((req, res, next) => {
  res.locals.userId = req.session?.userId || null;
  next();
});



// HOME ROUTE
app.get("/", (req, res) => {
  res.render("index")
})


///ARTICLES ROUTES

// GET all articles
app.get("/articles", requireLogin, async (req, res) => {
  const [articles] = await db.query(`
    SELECT p.id, p.title, p.subtitle, p.content,
           p.image1 AS image, p.created_at,
           u.fname
    FROM posts p
    LEFT JOIN users u ON p.user_id = u.id
    WHERE p.type='article'
    ORDER BY p.created_at DESC
  `)

  res.render("articles", { articles })
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

      res.redirect(`/view_posts/${postId}`)

    } else {
      // CREATE
      const newId = Date.now().toString()

      await db.query(`
        INSERT INTO posts
        (id, user_id, type, title, subtitle, content, image1)
        VALUES (?, ?, 'article', ?, ?, ?, ?)
      `, [newId, userId, title, subtitle, content, image])

      res.redirect(`/view_posts/${newId}`)
    }

  } catch (err) {
    console.error(err)
    res.send("Article save error")
  }
})


// View a single post
app.get("/view_posts/:id", requireLogin, async (req, res) => {
  const { id } = req.params

  const [[post]] = await db.query(`
    SELECT p.*, u.fname
    FROM posts p
    LEFT JOIN users u ON p.user_id = u.id
    WHERE p.id=? AND p.type='article'
  `, [id])

  if (!post) return res.status(404).send("Post not found")

  const [comments] = await db.query(`
    SELECT c.id, c.content, c.created_at, u.fname
    FROM comments c
    LEFT JOIN users u ON c.user_id = u.id
    WHERE c.post_id=?
    ORDER BY c.created_at ASC
  `, [id])

  res.render("view_post", {
    post,
    comments,
    editCommentId: req.query.edit
  })
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

    // confirm vanguard code
    if (vanguard !== process.env.VANGUARD_CODE) {
      return res.render("add_new_user", { error: "Invalid Vanguard code" })
    }

    if (password !== req.body.confirmPassword) {
      return res.render("add_new_user", { error: "Passwords do not match" })
    }

    // hash password
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
app.get("/user/:id", (req, res) => {
  const { id } = req.params
  const user = user_db.find(u => u.id === id)

  if (!user) return res.status(404).send("User not found")

  const savedItems = items.filter(i => user.savedItems?.includes(i.id))

  res.render("user", { user, savedItems })
})

// user login

app.get("/login", (req, res) => {
  res.render("login")
})



// handle login
app.post("/login", async (req, res) => {
  const { email, password } = req.body

  const [[user]] = await db.query(
    "SELECT * FROM users WHERE email=?",
    [email]
  )

  if (!user) return res.render("login", { error: "Invalid credentials" })

  let match = false

  // CASE 1 — already hashed
  if (user.password.startsWith("$2")) {
    match = await bcrypt.compare(password, user.password)
  }

  // CASE 2 — legacy plain password
  else {
    match = password === user.password

    if (match) {
      // upgrade to hash
      const newHash = await bcrypt.hash(password, 10)
      await db.query(
        "UPDATE users SET password=? WHERE id=?",
        [newHash, user.id]
      )
    }
  }

  if (!match) return res.render("login", { error: "Invalid credentials" })

  req.session.userId = user.id
  req.session.save(() => res.redirect("/profile"))
})



// delete user  
app.post("/user/delete/:id", async (req, res) => {
  const { id } = req.params

  await db.query("DELETE FROM users WHERE id=?", [id])

  req.session.destroy()

  res.redirect("/")
})

// add comments
app.post("/posts/:id/comments", (req, res) => {
  const postId = parseInt(req.params.id);
  const post = db.posts.find(p => p.id === postId);

  if (!post) return res.status(404).send("Post not found");

  const { name, comment } = req.body;

  // Add comment to the post
  post.comments.push({
    id: Date.now(),
    name,
    comment,
    date: new Date().toLocaleString()
  });
  const num = post.id;
  // Redirect back to the post page
  req.flash('success_msg', 'Comment created successfully');
  res.redirect('/view_posts/' + num);

});


//profile page
app.get("/profile", requireLogin, async (req, res) => {
  try {
    const userId = req.session.userId

    // USER
    const [[user]] = await db.query(
      `SELECT id, fname, lname, email, location, profilepic, role, created_at
       FROM users
       WHERE id=?`,
      [userId]
    )

    if (!user) return res.redirect("/login")

    // POSTS COUNT
    const [[postCount]] = await db.query(
      `SELECT COUNT(*) AS count
       FROM posts
       WHERE user_id=?`,
      [userId]
    )

    // SAVED COUNT
    const [[savedCount]] = await db.query(
      `SELECT COUNT(*) AS count
       FROM saved_items
       WHERE user_id=?`,
      [userId]
    )

    // RELATIONSHIP COUNT (safe: table may differ)
    let relCount = 0
    try {
      const [[r]] = await db.query(
        `SELECT COUNT(*) AS count
         FROM relationship_profiles
         WHERE user_id=?`,
        [userId]
      )
      relCount = r.count
    } catch {
      relCount = 0
    }

    res.render("profile", {
      user,
      stats: {
        posts: postCount.count,
        saved: savedCount.count,
        relationships: relCount
      }
    })

  } catch (err) {
    console.error("PROFILE ERROR →", err)
    res.send("Profile load error")
  }
})


// EDIT USER WITH DB
app.put("/edituser/:id", upload.single("profilepic"), async (req, res) => {
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

    res.redirect("/profile")
  } catch (err) {
    console.error(err)
    res.send("Update failed")
  }
})

// DELETE USER
app.delete("/deleteuser/:id", (req, res) => {
  const { id } = req.params

  const index = user_db.findIndex(u => u.id === id)

  if (index === -1) {
    return res.status(404).send("User not found")
  }

  user_db.splice(index, 1)

  res.redirect("/")
})

// Logout route
app.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login")
  })
})


// Edit comments page route
app.get("/posts/:id/edit_comments", (req, res) => {
  const postId = parseInt(req.params.id);
  const post = db.posts.find(p => p.id === postId);

  if (!post) return res.status(404).send("Post not found");

  res.render("view_post", { post });
});


// Edit comment route
app.post("/posts/:postId/comments/:commentId/edit", requireLogin, async (req, res) => {
  const { postId, commentId } = req.params
  const { comment } = req.body

  await db.query(
    `UPDATE comments
     SET content=?
     WHERE id=? AND post_id=?`,
    [comment, commentId, postId]
  )

  res.redirect("back")
})



// Delete a post
app.post("/delete_post/:id", requireLogin, async (req, res) => {
  const { id } = req.params

  await db.query("DELETE FROM comments WHERE post_id=?", [id])
  await db.query("DELETE FROM posts WHERE id=?", [id])

  res.redirect("/articles")
})


// Delete Comment
app.post("/posts/:postId/comments/:commentId/delete", requireLogin, async (req, res) => {
  const { postId, commentId } = req.params

  await db.query(
    "DELETE FROM comments WHERE id=? AND post_id=?",
    [commentId, postId]
  )

  res.redirect("back")
})



                  /// JOBS

// route to display jobs
app.get("/showjobs", requireLogin, async (req, res) => {
  const [rows] = await db.query(`
    SELECT p.id, p.title, p.location, p.contact,
           j.clinic, j.salary, j.description
    FROM posts p
    JOIN jobs j ON p.id = j.post_id
    ORDER BY p.created_at DESC
  `)

  res.render("showjobs", { jobs: rows })
})



// route to create job
app.post("/createJobs", requireLogin, async (req, res) => {
  const { title, clinic, location, salary, contact, description } = req.body
  const userId = req.session.userId
  const postId = Date.now().toString()

  // insert post
  await db.query(`
    INSERT INTO posts
    (id, user_id, type, title, location, contact)
    VALUES (?, ?, 'job', ?, ?, ?)
  `, [postId, userId, title, location, contact])

  // insert job details
  await db.query(`
    INSERT INTO jobs
    (post_id, clinic, salary, description)
    VALUES (?, ?, ?, ?)
  `, [postId, clinic, salary, description])

  res.redirect("/showjobs")
})


//EDIT JOBS
app.put("/editjob/:id", requireLogin, async (req, res) => {
  const { id } = req.params
  const { title, clinic, location, salary, contact, description } = req.body

  // update post
  await db.query(`
    UPDATE posts
    SET title=?, location=?, contact=?
    WHERE id=?
  `, [title, location, contact, id])

  // update job details
  await db.query(`
    UPDATE jobs
    SET clinic=?, salary=?, description=?
    WHERE post_id=?
  `, [clinic, salary, description, id])

  res.redirect("/showjobs")
})



//delete jobs

app.delete("/deletejob/:id", requireLogin, async (req, res) => {
  const { id } = req.params

  await db.query("DELETE FROM jobs WHERE post_id=?", [id])
  await db.query("DELETE FROM posts WHERE id=?", [id])

  res.redirect("/showjobs")
})



              /// MARKET PLACE

// show all items for sale
app.get("/market", requireLogin, async (req, res) => {
  const [rows] = await db.query(`
    SELECT p.id, p.title, p.content AS description,
           p.location, p.contact,
           p.image1, p.image2, p.image3,
           m.price
    FROM posts p
    JOIN market_items m ON p.id = m.post_id
    ORDER BY p.created_at DESC
  `)

  res.render("market", { items: rows })
})


// get a single item
app.get("/item/:id", requireLogin, async (req, res) => {
  const { id } = req.params

  const [[item]] = await db.query(`
    SELECT p.*, m.price
    FROM posts p
    JOIN market_items m ON p.id = m.post_id
    WHERE p.id = ?
  `, [id])

  if (!item) return res.status(404).send("Item not found")

  res.render("item", { item })
})



// create item for sale
app.post("/createitem", upload.array("images", 3), async (req, res) => {
  try {
    const { title, price, description, location, contact } = req.body
    const userId = req.session.userId
    const postId = Date.now().toString()

    const files = req.files || []
    const image1 = files[0]?.filename || null
    const image2 = files[1]?.filename || null
    const image3 = files[2]?.filename || null

    // insert post
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

    // insert market details
    await db.query(`
      INSERT INTO market_items (post_id, price)
      VALUES (?, ?)
    `, [postId, price])

    res.redirect("/market")

  } catch (err) {
    console.error(err)
    res.send("Error creating item")
  }
})



// EDIT ITEM AND UPDATE
app.put("/edititem/:id", upload.array("images", 3), async (req, res) => {
  const { id } = req.params
  const { title, price, description, location, contact } = req.body

  const files = req.files || []

  let image1 = null, image2 = null, image3 = null
  if (files.length > 0) {
    image1 = files[0]?.filename || null
    image2 = files[1]?.filename || null
    image3 = files[2]?.filename || null
  }

  // update post
  if (files.length > 0) {
    await db.query(`
      UPDATE posts
      SET title=?, content=?, location=?, contact=?,
          image1=?, image2=?, image3=?
      WHERE id=?
    `, [title, description, location, contact, image1, image2, image3, id])
  } else {
    await db.query(`
      UPDATE posts
      SET title=?, content=?, location=?, contact=?
      WHERE id=?
    `, [title, description, location, contact, id])
  }

  // update price
  await db.query(`
    UPDATE market_items
    SET price=?
    WHERE post_id=?
  `, [price, id])

  res.redirect("/market")
})



// delete item

app.delete("/deleteitem/:id", async (req, res) => {
  const { id } = req.params

  await db.query("DELETE FROM market_items WHERE post_id=?", [id])
  await db.query("DELETE FROM posts WHERE id=?", [id])

  res.redirect("/market")
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
  } else {
    await db.query(
      "INSERT INTO saved_items (user_id, post_id) VALUES (?, ?)",
      [userId, id]
    )
  }

  res.redirect("back")
})


// RELATIONSHIPS:

// get relationship form
app.get("/relationships/new", (req, res) => {
  res.render("relationshipForm")
})

// show relationships
app.get("/relationships", async (req, res) => {
  const [rows] = await db.query(`
    SELECT p.id AS post_id, r.*
    FROM posts p
    JOIN relationship_profiles r ON p.id = r.post_id
    WHERE p.type = 'relationship'
    ORDER BY p.created_at DESC
  `)

  res.render("relationships", { relationships: rows })
})

// get one relationship
app.get("/relationships/:id", async (req, res) => {
  const { id } = req.params

  const [[rel]] = await db.query(`
    SELECT p.user_id, r.*
    FROM posts p
    JOIN relationship_profiles r ON p.id = r.post_id
    WHERE p.id = ?
  `, [id])

  const isOwner = req.session.userId === rel.user_id

  res.render("relationshipView", { rel, isOwner })
})



// create relationship
app.post(
  "/create-relationship",
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

      res.redirect("/relationships")

    } catch (err) {
      console.error("Relationship insert error:", err)
      res.send("Error creating relationship profile")
    }
  }
)

// edit relationship
app.post("/relationships/edit/:id", async (req, res) => {
  const { id } = req.params
  const { bio, city, contact } = req.body

  await db.query(`
    UPDATE relationship_profiles
    SET bio=?, city=?, contact=?
    WHERE post_id=?
  `, [bio, city, contact, id])

  res.redirect("/relationships/" + id)
})


// delete relationhip
app.post("/relationships/delete/:id", async (req, res) => {
  const { id } = req.params

  await db.query("DELETE FROM relationship_profiles WHERE post_id=?", [id])
  await db.query("DELETE FROM posts WHERE id=?", [id])

  res.redirect("/relationships")
})


//CLINIC REVIEWS

// Get Clinic review form
app.get("/reviews/new", (req, res) => {
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

    res.redirect("/reviews/" + postId)

  } catch (err) {
    console.error("CREATE REVIEW ERROR:", err)
    res.status(500).send("Error creating review")
  }
})


//  show all reviews
app.get("/reviews", async (req, res) => {
  const [rows] = await db.query(`
    SELECT p.id AS post_id, r.*
    FROM posts p
    JOIN clinic_reviews r ON p.id = r.post_id
    ORDER BY p.created_at DESC
  `)

  res.render("showallreviews", { reviews: rows })
})


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

  // ⭐ comment ownership
  const commentsWithOwner = comments.map(c => ({
    ...c,
    isOwner: String(c.user_id) === String(userId)
  }))

  res.render("singlereviewView", {
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

  res.redirect("/reviews/" + postId)
})


// DELETE REVIEW COMMENT
app.post("/reviews/comments/delete/:postId/:commentId", requireLogin, async (req, res) => {
  const { postId, commentId } = req.params

  await db.query(
    "DELETE FROM comments WHERE id=? AND post_id=?",
    [commentId, postId]
  )

  res.redirect("/reviews/" + postId)
})

//get edit clinic view

app.get("/reviews/edit/:id", async (req, res) => {
  const { id } = req.params

  const [[review]] = await db.query(
    `SELECT * FROM clinic_reviews WHERE post_id=?`,
    [id]
  )

  res.render("reviewEdit", { review })
})

// post edit clinic view

app.post("/reviews/edit/:id", async (req, res) => {
  const { id } = req.params
  const { rating, pros, cons, recommendation } = req.body

  await db.query(
    `UPDATE clinic_reviews
     SET rating=?, pros=?, cons=?, recommendation=?
     WHERE post_id=?`,
    [rating, pros, cons, recommendation, id]
  )

  res.redirect("/reviews/" + id)
})

// delete clinic review
app.post("/reviews/delete/:id", requireLogin, async (req,res)=>{
  const { id } = req.params

  await db.query(
    "DELETE FROM clinic_reviews WHERE post_id=?",
    [id]
  )

  res.redirect("/reviews")
})




// edit clinic review
app.post("/reviews/edit/:id", requireLogin, async (req,res)=>{
  const { id } = req.params
  const { rating, pros, cons, recommendation } = req.body

  await db.query(
    `UPDATE clinic_reviews
     SET rating=?, pros=?, cons=?, recommendation=?
     WHERE post_id=?`,
    [rating, pros, cons, recommendation, id]
  )

  res.redirect("/reviews/view/" + id)
})



app.post("/reviews/comments/add/:reviewId", requireLogin, async (req,res)=>{
  const { reviewId } = req.params
  const { content } = req.body
  const userId = req.session.userId

  await db.query(
    `INSERT INTO comments (post_id, user_id, content)
     VALUES (?, ?, ?)`,
    [reviewId, userId, content]
  )

  res.redirect("/reviews/" + reviewId)

})


// ADMIN DASHBOARD
app.get("/admin", requireAdmin, async (req, res) => {

  const [[counts]] = await db.query(`
    SELECT
      (SELECT COUNT(*) FROM users) AS users,
      (SELECT COUNT(*) FROM posts) AS posts,
      (SELECT COUNT(*) FROM jobs) AS jobs,
      (SELECT COUNT(*) FROM market_items) AS market,
      (SELECT COUNT(*) FROM clinic_reviews) AS reviews
  `)

  res.render("admin/dashboard", { counts })
})


// manage users
app.get("/admin/users", requireAdmin, async (req, res) => {
  const [users] = await db.query(
    "SELECT id, fname, lname, email, role FROM users ORDER BY created_at DESC"
  )
  res.render("admin/users", { users })
})




app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});