/**
 * Linking routes to controllers
 */

const router = require('express').Router();
const {homeGet} = require('./controllers/homeControl');
const {searchGet, explainGet} = require('./controllers/searchControl');
const {questionGet} = require('./controllers/questionControl');

router.get('/', homeGet);
router.get('/search', searchGet);
router.get('/question/:id', questionGet);
router.get('/explain', explainGet);

module.exports = router;
