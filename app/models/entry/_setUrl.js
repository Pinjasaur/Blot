var helper = require('helper');
var forEach = helper.forEach;
var ensure = helper.ensure;
var _ = require('lodash');
var urlNormalizer = helper.urlNormalizer;
var UID = helper.makeUid;
var makeSlug = helper.makeSlug;
var withoutExtension = helper.withoutExtension;
var redis = require('../client');
var Key = require('./key').url;
var model = require('./model');
var get = require('./get');

//'/style.css', '/script.js', '/feed.rss', '/robots.txt', '/sitemap.xml'
// are not possible because . is replaced with. ideally check for
// all template views here...
var banned = [
  '/archives',
  '/archive',
  '/search',
  '/tagged',
  '/public',
  ''
];

var MIN_SUMMARY_SLUG_WORDS = 3;
var MAX_SUMMARY_SLUG_WORDS = 10;

var PERMALINK_PERMUTATIONS = 5;

// The random permalinks are
// this long. I figure 3 gives
// us (26 * 2 + 10)^3 (= 238,328)
// possible permalinks which is more
// than enough for one blog, espcially
// since the circumstances under
// which Blot needs to generate
// a random url are rare enough.
// It also avoids the issue of rude
// 4 letter words being generated.
var UID_LENGTH = 3;

// We generate this number
// of random permalinks in
// case all else fails.
var UID_PERMUTATIONS = 500;

// console.log(Candidates({
//   permalink: '',
//   slug: '',
//   summary: '',
//   url: '',
//   name: 'a.jpg',
//   path: '/a.jpg'
// }));

function Candidates (entry) {

  var candidates = [];

  if (entry.permalink) {

    // The user has specified a permalink in the
    // entry's metadata. We should use this if we can.
    candidates.push(entry.permalink);

    // If the permalink is unavailable, try appending a number
    // e.g. if 'apple', try 'apple-2', 'apple-3' ... 'apple-99'
    for (var i = 2; i < PERMALINK_PERMUTATIONS; i++)
      candidates.push(entry.permalink + '-' + i);

  }

  // This is generated from the entry's title
  if (entry.slug) {
    candidates.push(entry.slug);
  }

  if (entry.name)
    candidates.push(makeSlug(withoutExtension(entry.name)));

  if (entry.path)
    candidates.push(makeSlug(withoutExtension(entry.path.split('/').join('-'))));

  if (entry.summary) {

    var words = entry.summary.split(' ');

    for (var y = MIN_SUMMARY_SLUG_WORDS; y < words.length && y < MAX_SUMMARY_SLUG_WORDS; y++) {
      candidates.push(makeSlug(words.slice(0, y).join('-')));
    }
  }

  // If we make it path the permalink chosen by the
  // user, it's possible that we fell through to the
  // randomly generated (UID()...) permalinks below.
  // If so, we should insert the entry's previous URL
  // if it exists to ensure that the entry retains
  // a randomly generated URL consistently.
  if (entry.url)
    candidates.push(entry.url);

  for (var j = 0; j < UID_PERMUTATIONS; j++)
    candidates.push(UID(UID_LENGTH));

  // Trim, lowercase, strip trailing /, add leading /
  // ensure valid url pathname. Always returns a string
  // can be empty if invalid or just '/'
  candidates = candidates.map(urlNormalizer);

  // We store the decoded version. Not sure if this is a good idea
  // or not but it works for now. Shit gets encoded by default
  // by pandoc I believe. Perhaps I could store both?
  candidates = candidates.map(decodeURIComponent);

  candidates = candidates.filter(function(candidate){

    if (!candidate) return false;

    // WE DONT EVER ADD ENTRY.PATH so images are always accessible
    // It's possible that entry.name when normalized === entry.path
    if (entry.path && candidate === entry.path) return false;

    if (banned.indexOf(candidate) > -1) return false;

    return true;
  });

  candidates = _.uniq(candidates);

  return candidates;
}

function check (blogID, candidate, entryID, callback) {

  var key = Key(blogID, candidate);

  redis.get(key, function(err, existingID){

    if (err) return callback(err);

    // This url is available and unused
    if (!existingID) return callback();

    // This url points to this entry already
    if (existingID === entryID) return callback();

    // This url points to a different entry
    get(blogID, existingID, function(existingEntry){

      // For some reason (bug) the url key was
      // set but the entry does not exist. Claim the url.
      if (!existingEntry) return callback();

      // The existing entry has since moved to a different url
      // (perhaps the author modified its permalink etc...)
      // so this entry can claim this url.
      if (existingEntry.url !== candidate) return callback();

      // The existing entry was deleted after claiming this
      // url, so this entry can claim it.
      if (existingEntry.deleted) return callback();

      // If we reach this far down, it means the entry
      // which has claimed this url is still visible and
      // still uses this url, so we can't claim it.
      return callback(null, true);
    });
  });
}

// this needs to return an error if something went wrong
// and the finalized, stored url to the entry...
module.exports = function (blogID, entry, callback) {

  ensure(blogID, 'string')
    .and(entry, model)
    .and(callback, 'function');

  if (entry.draft || entry.deleted)
    return callback(null, '');

  // does this cause a memory leak? we sometimes
  // exist before calling all the next functions
  // if we find a successful candidate.
  forEach(Candidates(entry), function(candidate, next){

    check(blogID, candidate, entry.id, function(err, taken){

      if (err) return callback(err);

      if (taken) return next();

      var key = Key(blogID, candidate);

      redis.set(key, entry.id, function(err){

        if (err) return callback(err);

        return callback(null, candidate);
      });
    });
  }, function(){

    // if we exhaust the list of candidates, what should happen?
    // just return an error for now... TODO in future, just keep
    // generating UIDS... but whatever for now.
    callback(new Error('Could not find a permalink for ' + entry.id));
  });
};