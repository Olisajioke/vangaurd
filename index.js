
import express from "express";
import bodyParser from "body-parser";
import session from "express-session";
import flash from "connect-flash";
import multer from "multer";
import methodOverride from "method-override"
import path from "path"





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


const db = {
  users: [],
  posts: []
};

const items = [];

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



const user_db = [];
let jobs = []



app.get("/", (req, res) => {
  res.render("index")
})



///ARTICLES ROUTES

app.get("/articles", (req, res) => {
    db.posts.sort((a, b) => b.id - a.id);
    res.render("articles", { db: db  });
});


// Route to create a new post or edit an existing one
app.get("/new_clinic_stories", (req, res) => {
  const postId = req.query.id;       // undefined if creating new
  const isEdit = req.query.mode === "edit";  // true if editing

  let post = null;
  if (isEdit && postId) {
    post = db.posts.find(p => p.id === parseInt(postId));
  }

  res.render("create_post", { post, isEdit });
});


// Handle form submission for creating or editing a post
app.post("/submit_story", upload.single("image"), (req, res) => {
  const { title, subtitle, content, author, postId } = req.body; // <-- postId will be sent if editing
  const postdate = new Date().toLocaleDateString();

  if (postId) {
    // --- EDIT MODE ---
    const existingPost = db.posts.find(p => p.id === parseInt(postId));

    if (!existingPost) {
      return res.status(404).send("Post not found");
    }

    // Update fields
    existingPost.title = title;
    existingPost.subtitle = subtitle;
    existingPost.content = content;
    existingPost.author = author;
    existingPost.date = postdate;

    // Only update image if a new file is uploaded
    if (req.file) {
      existingPost.image = req.file.filename;
    }
    req.flash('success_msg', 'Post updated successfully');
    res.redirect(`/view_posts/${existingPost.id}`);
  } else {
    // --- CREATE NEW POST ---
    const newPostId = Date.now();
    db.posts.push({
      id: newPostId,
      title,
      subtitle,
      content,
      image: req.file ? req.file.filename : null,
      author,
      date: postdate,
      comments: []
    });

    db.users.push({
      id: newPostId,
      name: author
    });
    req.flash('success_msg', 'New post created successfully');
    res.render("articles", { db: db, success_msg: "New post created successfully!", content: ""});
  }
});


// View a single post
app.get("/view_posts/:id", (req, res) => {
    // view a single post based on ID
  const postId = parseInt(req.params.id); // grab the ID from URL
  const post = db.posts.find(p => p.id === postId);
  const author = db.users.find(u => u.id === postId);

  if (!post) {
    req.flash('error', 'Post not found');
    return res.status(404).send("Post not found");
  }

  const success_msg = req.params.success_msg || req.flash('success_msg');
  res.render("view_post", { post: post, author: author, editCommentId: req.query.edit, success_msg: success_msg });
});


// Route to display the add new user form
app.get("/add_new_user", (req, res) => {
    res.render("add_new_user");
});

app.post("/add_new_user", upload.single("profilepic"), (req, res) => {
	var fname = req.body.fName;
	var lname = req.body.lName;
	var fullname = fname + " " + lname;
    var email = req.body.email;
    var password = req.body.password;
    var profilepic = req.file;
    user_db.push({fullname: fullname,  email: email, password: password, profilepic: profilepic});
    if (user_db.length > 0) {
        console.log("New user added:", user_db[user_db.length - 1]);
        console.log(user_db[user_db.length - 1].fullname);
        req.flash('success', 'Your profile was created successfully!');
    }
    
	res.render("index", { db: db, success_msg: "Your profile was created successfully!", content: ""});
});


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

// Edit comments page route
app.get("/posts/:id/edit_comments", (req, res) => {
  const postId = parseInt(req.params.id);
  const post = db.posts.find(p => p.id === postId);

  if (!post) return res.status(404).send("Post not found");

  res.render("view_post", { post });
});


// Edit comment route
app.post("/posts/:postId/comments/:commentId/edit", (req, res) => {
  const postId = parseInt(req.params.postId);
  const commentId = parseInt(req.params.commentId);

  const post = db.posts.find(p => p.id === postId);
  if (!post) return res.status(404).send("Post not found");

  const comment = post.comments.find(c => c.id === commentId);
  if (!comment) return res.status(404).send("Comment not found");

  comment.comment = req.body.comment;
  comment.date = new Date().toLocaleString();
  req.flash('success_msg', 'Comment updated successfully');
  res.redirect("/view_posts/" + postId);
});


// Delete a post
app.post("/delete_post/:id", (req, res) => {
    const postId = parseInt(req.params.id);
    const postIndex = db.posts.findIndex(p => p.id === postId);

    if (postIndex === -1) {
        return res.status(404).send("Post not found");
    }

    // Remove the post
    db.posts.splice(postIndex, 1);

    // remove the author as well
    const userIndex = db.users.findIndex(u => u.id === postId);
    if (userIndex !== -1) db.users.splice(userIndex, 1);

    req.flash('success_msg', 'Post deleted successfully');
    res.redirect("/articles"); // Go back to homepage
});

// Delete Comment
app.post("/posts/:postId/comments/:commentId/delete", (req, res) => {
  const postId = parseInt(req.params.postId);
  const commentId = parseInt(req.params.commentId);

  const post = db.posts.find(p => p.id === postId);
  if (!post) return res.status(404).send("Post not found");

  post.comments = post.comments.filter(c => c.id !== commentId);
  req.flash('success_msg', 'Comment deleted successfully');
  res.redirect("/view_posts/" + postId);
});



                  /// JOBS

// route to display jobs
app.get("/showjobs", (req, res) => {
  res.render("showjobs", {jobs: jobs})
})


// route to create job
app.post("/createJobs", (req, res) => {
  const { title, clinic, location, salary, contact, description } = req.body

  const newJob = {
    id: Date.now().toString(),
    title,
    clinic,
    location,
    salary,
    contact,
    description,
    createdAt: new Date()
  }

  jobs.push(newJob)

  res.redirect("/showjobs")
})

//EDIT JOBS
app.put("/editjob/:id", (req, res) => {
  const { id } = req.params;

  const job = jobs.find(j => j.id === id);
  if (!job) return res.status(404).send("Job not found");

  const { title, clinic, location, salary, contact, description } = req.body;

  job.title = title;
  job.clinic = clinic;
  job.location = location;
  job.salary = salary;
  job.contact = contact;
  job.description = description;

  res.redirect("/showjobs")
})


//delete jobs

app.delete('/deletejob/:id', (req, res) => {
  const { id } = req.params

  const index = jobs.findIndex(j => j.id === id)

  if (index === -1) {
    return res.status(404).send("Job not found")
  }

  jobs.splice(index, 1)

  res.redirect("/showjobs")
})




              /// MARKET PLACE

// show all items for sale
app.get("/market", (req, res) => {
  res.render("market", { items })
})

// get a single item
app.get("/item/:id", (req, res) => {
  const { id } = req.params
  const item = items.find(i => i.id === id)

  if (!item) return res.status(404).send("Item not found")

  res.render("item", { item })
})


// create item for sale
app.post("/createitem", upload.array("images", 3), (req, res) => {
  const { title, price, description, location, seller, contact } = req.body
  const imageFiles = req.files.map(f => f.filename);

  const newItem = {
    id: Date.now().toString(),
    title,
    price,
    description,
    seller,
    location,
    contact,
    images: imageFiles,
    createdAt: new Date()
  }

  items.push(newItem)

  res.redirect("/market")
})


// edit Items
app.put("/edititem/:id", upload.array("images", 3), (req, res) => {
  const { id } = req.params
  const item = items.find(i => i.id === id)

  if (!item) return res.status(404).send("Item not found")

  const { title, price, description, seller, contact, location } = req.body

  item.title = title
  item.price = price
  item.description = description
  item.seller = seller
  item.contact = contact
  item.location = location

  // if new images uploaded → replace
  if (req.files && req.files.length > 0) {
    item.images = req.files.map(f => f.filename)
  }

  res.redirect("/market")
})


// delete item

app.delete("/deleteitem/:id", (req, res) => {
  const { id } = req.params
  const index = items.findIndex(i => i.id === id)

  if (index === -1) return res.status(404).send("Item not found")

  items.splice(index, 1)

  res.redirect("/market")
})


app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});