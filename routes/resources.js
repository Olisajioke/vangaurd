
import express from "express";
import db from "../db.js";
import multer from "multer";
import { requireLogin } from "../middlewares/auth.js";

const router = express.Router();
// --- middleware: require login ---


//IMAGES PATH CONFIG



const storage = multer.diskStorage({
  destination: "public/uploads/resources",
  filename: (req, file, cb) => {
    const unique = Date.now() + "-" + file.originalname;
    cb(null, unique);
  }
});

const upload = multer({ storage });


//RESOURCES ROUTE


// GET RESOURCES
router.get("/", async (req, res) => {
  
  try {
    const [articles] = await db.query(
      `SELECT id, title, subtitle, image, content, slug, updated_at
       FROM resources_articles
       ORDER BY updated_at DESC`
    );
    //console.log(req.session.userId);
    //console.log("SESSION:", req.session);
    const heroImage = null;
    res.render("resources/list", {
      articles,
      userId: req.session.userId || null,
      success: [],
      error: [],
      heroImage
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading resources");
  }
});

// create resources
// CREATE PAGE
router.get("/new", requireLogin, (req, res) => {
  res.render("resources/new");
});


// CREATE RESOURCE
router.post("/new", requireLogin, upload.single("image"), async (req, res) => {
  try {
    const { title, subtitle, content } = req.body;
    const userId = req.session.userId;
    const image = req.file ? `/uploads/resources/${req.file.filename}` : null;

    const slugBase = title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-");

    let slug = slugBase;
    let counter = 1;

    while (true) {
      const [[existing]] = await db.query(
        "SELECT id FROM resources_articles WHERE slug = ?",
        [slug]
      );
      if (!existing) break;
      slug = `${slugBase}-${counter++}`;
    }

    const [result] = await db.query(
      `INSERT INTO resources_articles
       (title, subtitle, slug, content, image, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [title, subtitle, slug, content, image, userId]
    );

    await db.query(
      `INSERT INTO resources_contributors (article_id, user_id)
       VALUES (?, ?)`,
      [result.insertId, userId]
    );
    req.flash("success", "Post created successfully!");
    res.redirect(`/resources/${slug}`);

  } catch (err) {
    console.error(err);
    res.status(500).send("Error creating resource");
  }
});


//view single page
router.get("/:slug", async (req, res) => {
  try {
    const { slug } = req.params;

    const [[article]] = await db.query(
      `SELECT ra.*, u.fname, u.lname
       FROM resources_articles ra
       JOIN users u ON u.id = ra.created_by
       WHERE ra.slug = ?`,
      [slug]
    );

    if (!article) return res.status(404).send("Resource not found");

    const [contributors] = await db.query(
      `SELECT u.id, u.fname, u.lname
       FROM resources_contributors rc
       JOIN users u ON u.id = rc.user_id
       WHERE rc.article_id = ?`,
      [article.id]
    );

    const [comments] = await db.query(
      `SELECT c.*, u.fname, u.lname
       FROM comments c
       JOIN users u ON u.id = c.user_id
       WHERE c.post_id = ? AND c.post_type = 'resource'
       ORDER BY c.created_at DESC`,
      [article.id]
    );

    res.render("resources/view", {
      article,
      contributors,
      comments,
    });

  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading resource");
  }
});


router.get("/:slug/edit", requireLogin, async (req, res) => {
  try {
    const { slug } = req.params;

    const [[article]] = await db.query(
      "SELECT * FROM resources_articles WHERE slug = ?",
      [slug]
    );

    if (!article) return res.status(404).send("Not found");

    res.render("resources/edit", { article});

  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading editor");
  }
});

//EDIT RESOURCES
router.post("/:slug/edit",
  requireLogin,
  upload.single("image"),
  async (req, res) => {
    try {
      const { slug } = req.params;
      const { title, subtitle, content } = req.body || {};
      const userId = req.session.userId;


      const [[article]] = await db.query(
        "SELECT id, image FROM resources_articles WHERE slug = ?",
        [slug]
      );

      if (!article) return res.status(404).send("Not found");

      // determine image path
      let imagePath = article.image;

      if (req.file) {
        imagePath = "/uploads/resources/" + req.file.filename;
      }

      // update article (including image)
      await db.query(
        `UPDATE resources_articles
         SET title = ?, subtitle = ?, content = ?, image = ?
         WHERE id = ?`,
        [title, subtitle, content, imagePath, article.id]
      );

      // add contributor (ignore duplicates)
      await db.query(
        `INSERT IGNORE INTO resources_contributors
         (article_id, user_id)
         VALUES (?, ?)`,
        [article.id, userId]
      );

      req.flash("success", "Post edited successfully!");
      res.redirect(`/resources/${slug}`);

    } catch (err) {
      console.error(err);
      res.status(500).send("Error saving resource");
    }
  }
);


//comments
// post

// routes/comments.js
router.post("/comments/new", requireLogin, async (req, res) => {
  try {
    const { post_id, post_type, content } = req.body;
    const userId = req.session.userId;

    if (!content || !content.trim()) {
      req.flash("error", "Comment cannot be empty");
      res.redirect(req.get("referer") || "/");
    }

    await db.query(
      `INSERT INTO comments (post_id, user_id, content, post_type)
       VALUES (?, ?, ?, ?)`,
      [post_id, userId, content.trim(), post_type]
    );
    req.flash("success", "Post created successfully!");
    res.redirect(req.get("referer") || "/resources");

  } catch (err) {
    console.error(err);
    res.status(500).send("Error creating comment");
  }
});

//edit
router.post("/comments/:id/edit", requireLogin, async (req, res) => {
  try {
    const commentId = req.params.id;
    const { content } = req.body;
    const userId = req.session.userId;

    const [[comment]] = await db.query(
      "SELECT user_id FROM comments WHERE id = ?",
      [commentId]
    );

    if (!comment || comment.user_id !== userId) {
      return res.status(403).send("Not allowed");
    }

    await db.query(
      "UPDATE comments SET content = ? WHERE id = ?",
      [content.trim(), commentId]
    );
    req.flash("success", "Comment edited successfully!");
    res.redirect(req.get("referer") || "/");
  } catch (err) {
    console.error(err);
    res.status(500).send("Error editing comment");
  }
});

// delete route
router.post("/comments/:id/delete", requireLogin, async (req, res) => {
  try {
    const commentId = req.params.id;
    const userId = req.session.userId;

    const [[comment]] = await db.query(
      "SELECT user_id FROM comments WHERE id = ?",
      [commentId]
    );

    if (!comment || comment.user_id !== userId) {
      return res.status(403).send("Not allowed");
    }

    await db.query(
      "DELETE FROM comments WHERE id = ?",
      [commentId]
    );
    req.flash("success", "Comment deleted successfully!");
    res.redirect(req.get("referer") || "/");
  } catch (err) {
    console.error(err);
    res.status(500).send("Error deleting comment");
  }
});


export default router;
