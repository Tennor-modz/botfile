require('dotenv').config();

module.exports = {
  BOT_NAME: process.env.BOT_NAME,
  OWNER_NAME: process.env.OWNER_NAME,
  OWNER_NUMBER: process.env.OWNER_NUMBER,
  SESSION_DIR: process.env.SESSION_DIR,
  SESSION_ID: process.env.SESSION_ID,
  NO_PREFIX: process.env.NO_PREFIX === 'true',
  STATUS_VIEW: process.env.STATUS_VIEW === 'true',
};
