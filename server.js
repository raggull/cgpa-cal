require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

const cgpaRoutes = require('./routes/cgpaRoutes');
const authRoutes = require('./routes/authRoutes');
const sheetsRoutes = require('./routes/sheetsRoutes');
const requireAuth = require('./middleware/authMiddleware');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Login / create account page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Grade-entry page (client-side JS redirects here to '/' if not signed in)
app.get('/cgpa.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'cgpa.html'));
});

// API routes
app.use('/api/auth', authRoutes);          // public: google sign-in, config, me
app.use('/api/grades', requireAuth, cgpaRoutes); // protected: needs a signed-in account
app.use('/api/sheets', requireAuth, sheetsRoutes); // protected: add-to-sheet + admin bulk convert

// Connect to MongoDB, then start the server only once the connection is up
mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('MongoDB connected');
    app.listen(PORT, () => {
      console.log(`Server running on ${PORT}`);
    });
  })
  .catch(err => {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  });