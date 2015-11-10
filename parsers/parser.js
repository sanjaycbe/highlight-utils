"use strict";

var _ = require('lodash'),
    async = require('async'),
    config = require("../siteleaf.config.js"),
    merge = require('merge'),
    moment = require('moment'),
    parsers = {
      ibooks: require("./ibooks"),
      readmill: require("./readmill"),
      kindle: require("./kindle")
    },
    Promise = require('promise'), // AWS Lambda uses Node 0.10.x
    Siteleaf = require("siteleaf-api"),
    slug = require('slug'),
    truncate = require('truncate'),
    uuid = require('uuid');

var cache = {
  highlights: null,
  books: null
};

var siteleaf = new Siteleaf({
  apiKey: config.key,
  apiSecret: config.secret
});

var addBookAndHighlights = function(book, highlights) {
  if (!highlights.length) return Promise.resolve();

  var timerName = "addBookAndHighlights__" + slug(truncate(book.title, 20, { ellipsis: null }));
  console.time(timerName);

  return getBook({
    title: book.title,
    metadata: {
      author: book.author,
      asin: book.asin,
      uuid: uuid.v4()
    }
  })
    .then(createHighlights.bind(null, highlights))
    .then(console.timeEnd.bind(null, timerName));
};

var getHighlights = function() {
  if (cache.highlights) return Promise.resolve(cache.highlights);

  return siteleaf.request('collections/' + config.highlights + '/documents', {
    qs: { limit: 9999 }
  })
    .then(function (highlights) {
      cache.highlights = highlights;
      return highlights;
    });
};

var filterOutExistingHighlights = function(book, newHighlights, existingHighlights) {
  if (!existingHighlights.length) return newHighlights;

  existingHighlights = _.where(existingHighlights, {
    metadata: {
      book_uuid: book.metadata.uuid
    }
  });

  if (existingHighlights.length) {
    console.log('Filtering through %d existing highlights for %s', existingHighlights.length, book.title);
    var highlightBodies = existingHighlights.map(function (highlight) {
      return highlight.body.trim();
    });

    newHighlights = _.reject(newHighlights, function (highlight) {
      var res = _.includes(highlightBodies, highlight.content.trim());
      if (res) console.log("Found existing highlight matching: %s", truncate(highlight.content, 30));
      return res;
    });
  }

  return newHighlights;
};

var createHighlights = function(highlights, book) {
  return getHighlights() // First we check if any of these highlights already exist and ignore them if so.
    .then(filterOutExistingHighlights.bind(null, book, highlights))
    .then(function (filteredHighlights) {
      if (!filteredHighlights.length) return Promise.resolve();

      return new Promise(function (resolve) {
        console.log("Creating %d highlights for %s", filteredHighlights.length, book.title);
        var i = 1;

        async.eachSeries(filteredHighlights, function (highlight, cb) {
          return createHighlight(highlight, book)
            .then(function () {
              console.log("Created %d of %d for %s", i++, filteredHighlights.length, book.title);
            })
            .then(function () { return cb(); });
        }, resolve);
      });
    });
};

var createHighlight = function(highlight, book) {
  var truncatedTitle = truncate(book.title, 20, { ellipsis: null });

  var params = {
    body: highlight.content,
    title: truncatedTitle + ': ' + truncate(highlight.content, 60),
    path: slug(truncatedTitle + '-' + uuid.v4(), { lower: true }),
    metadata: {
      book_uuid: book.metadata.uuid,
      comments: highlight.comments,
      location: highlight.location ? String(highlight.location) : null, // convert to string so we can sort in Liquid
      source: highlight.source
    }
  };

  if (highlight.date) {
    // Normalize date formats:
    var highlightMoment = moment(highlight.date, [moment.ISO_8601, 'MMMM D, YYYY']);

    if (highlightMoment.isValid()) {
      params.metadata.highlighted_on = highlightMoment.toISOString();
    } else {
      console.log("Invalid date: %s", highlight.date);
    }
  }

  if (highlight.user) params.metadata.highlight_by = highlight.user;

  return siteleaf.request('collections/' + config.highlights + '/documents', {
    method: 'POST',
    body: params
  })
    .then(function (highlight) {
      return cache.highlights.push(highlight);
    });
};

var getBooks = function() {
  if (cache.books) return Promise.resolve(cache.books);

  return siteleaf.request('collections/' + config.books + '/documents', {
    qs: { limit: 9999 }
  })
    .then(function (books) {
      cache.books = books;
      return books;
    });
};

var getBook = function(bookParams) {
  return getBooks()
    .then(function (books) {
      // We compare the original_title, this way we can change the display title
      // if for some reason it isn't accurate
      var existingBook = _.findWhere(books, {
        metadata: {
          original_title: bookParams.title
        }
      });

      if (existingBook) {
        return Promise.resolve(existingBook);
      } else {
        return createBook(bookParams);
      }
    });
};

var createBook = function(params) {
  params.metadata = merge(params.metadata, {
    original_title: params.title,
    date: moment().utcOffset('-05:00').format()
  });

  return siteleaf.request('collections/' + config.books + '/documents', {
    method: 'POST',
    body: params
  })
    .then(function (book) {
      cache.books.push(book);
      return book;
    });
};

var parse = function(mail) {
  console.time('complete');

  return new Promise(function (resolve) {
    // An email can include multiple attachments, so we pass and check in each parser:
    var results = [];
    var ibooks = new parsers.ibooks(mail);
    var readmill = new parsers.readmill(mail);
    var fukindle = new parsers.kindle(mail);

    // iBooks can only include the highlights in the body
    if (ibooks.parseable()) results.push(ibooks.parse());

    // The exported reading-data.json or liked-highlights-data.json
    if (readmill.parseable()) results = results.concat(readmill.parse());

    // A JSON file exported using the bookmarklet OR "My Clippings.txt"
    if (fukindle.parseable()) results = results.concat(fukindle.parse());

    // Use async so we don't kill the Siteleaf API:
    async.eachSeries(results, function (result, cb) {
      addBookAndHighlights(result.book, result.highlights)
        .then(function () { return cb(); });
    }, function () {
      console.timeEnd('complete');
      resolve();
    });
  });
};

module.exports = parse;
