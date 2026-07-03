const { Pool } = require('pg');

const pool = new Pool({
  user: 'postgres',         // Default PostgreSQL username
  host: 'localhost',
  database: 'pbe_oneforall', // Your database name
  password: 'PilarBahtera', // The password you set during installation
  port: 5432,
});

module.exports = {
  query: (text, params) => pool.query(text, params),
};