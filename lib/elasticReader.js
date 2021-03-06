/**
 * Reads stack overflow files from a directory and indexes into elastic search.
 * @module elasticReader
 */

const fs = require('fs-extra');
const path = require('path');
const elasticClient = require('./elasticClient');
const {readFile} = require('./dataSources');
const prettyjson = require('prettyjson'); // eslint-disable-line no-unused-vars
const {parameters} = require('../lib/parameters');
const html2plaintext = require('html2plaintext');
const stemmer = require('porter-stemmer').stemmer;

/**
 * Callback used to track processing progress
 * @typedef {function} PercentCallback
 * @global
 * @callback
 * @param {number} totalLines - Number of items read
 * @param {number} totalHits - Number of items that are processed in some way
 * @param {number} percentDone - Percentage complete
 * @param {string} description - human readable description of the step being tracked
 */

// Definitions of integer field values from
// https://meta.stackexchange.com/questions/2677/database-schema-documentation-for-the-public-data-dump-and-sede
const POSTTYPEID_QUESTION = 1;
const POSTTYPEID_ANSWER = 2;
const VOTETYPEID_UPMOD = '2';
const VOTETYPEID_DOWNMOD = '3';

async function extendId(client, indexPrefix, questionId) {
  let localHits = 0;
  const answers = await client.search({
    index: indexPrefix + 'sepost',
    body: {
      from: '0',
      size: '1000',
      query: {
        term: {
          ParentId: questionId,
        },
      },
    },
  });
  if (answers.hits.hits.length) {
    const question = await elasticClient.getDocument(client, indexPrefix + 'sepost', 'sepost', questionId);
    if (question.found && question._source.PostTypeId == POSTTYPEID_QUESTION) {
      const indexPromises = [];
      answers.hits.hits.forEach(hit => {
        localHits++;
        const answerDocument = hit._source;
        answerDocument.Tags = question._source.Tags;
        answerDocument.ViewCount = question._source.ViewCount;
        answerDocument.QuestionTitle = question._source.Title;
        indexPromises.push(
          // We want to continue even if a single put has an error
          elasticClient.promisePutDocument(client, indexPrefix + 'sepost', 'sepost', answerDocument)
            .catch(e => {
              console.log('Ignored putDocument Error: ' + e);
              return e;
            }));
      });
      await Promise.all(indexPromises);
    }
  }
  return localHits;
}

async function indexFile(filePath, fileType, client, indexPrefix) {
  // console.log('Deleting and recreating index: ' + indexPrefix + fileType);
  try {
    await elasticClient.deleteIndex(client, indexPrefix + fileType);
  } catch (err) { }
  await elasticClient.createIndex(client, indexPrefix + fileType, fileType);

  return readFile(filePath, fileType, async (lineObject) => {
    //if (fileType == 'sepost') console.log('indexFile\n' + prettyjson.render(lineObject));
    let result = null;
    try {
      result = await elasticClient.putDocument(client, indexPrefix + fileType, fileType, lineObject);
    } catch (err) {
      if (err.message.startsWith('Invalid Id')) {
        // We silently reject invalid ids like -1
        //console.log('ignoring failed indexing of row: ' + err.message);
      } else {
        console.log('Failed to index row: ' + prettyjson.render(lineObject));
        console.log('Error: ' + err);
      }
    }
    return result;
  });
}

const elasticReader = module.exports = {

  /**
   * Setup appropriate function to determine if an sepost matches a words string
   * @param {string} testString - a list of words to include (or exclude), space separated.
   * @param {boolean} isAccept - true if making for accept, false if for exclude
   * @return {function(lineObject)} - a function that can be used to evalute 
   */
  makeDoesMatch: function (testString, isAccept) {
    // return a set of words that are present in some text
    function stemmedWords(text) {
      const wordArray =
        text
          .toLowerCase()
          .split(/[^a-z0-9-]/) // get rid of all punctuation except '-'
          .map(word => stemmer(word));
      const wordSet = new Set(wordArray);
      //console.log(`wordArray: ${prettyjson.render(wordArray)}`);
      // Also break any phrases with - into words and add them.
      wordArray.forEach(word => {
        if (word.includes('-')) {
          word.split('-').forEach(subWord => {
            wordSet.add(stemmer(subWord));
          });
        }
      });
      //console.log(`wordSet: ${[...wordSet.values()]}`);
      return wordSet;
    }

    // If there are no tags, accept everything and reject nothing
    if (!testString) {
      return () => isAccept;
    }
    const testSplit = testString.toLowerCase().split(' ');
    const testWords = testSplit.map(word => stemmer(word));

    return (lineObject) => {
      try {
        // We'll assume that a word occurring in the title is
        // equivalent to a tag.
        let title = lineObject.Title || '';
        const textBody = lineObject.Body || '';
        // For answers, use the beginning of the text as the title
        if (!isAccept && !title && textBody) {
          title = (textBody.length > 60 ? textBody.substr(0, 60) + '...' : textBody);
        }
        const titleWords = title && stemmedWords(html2plaintext(title));
        const tagWords = lineObject.Tags && stemmedWords(lineObject.Tags);
        const bodyWords = isAccept ? null : (textBody && stemmedWords(html2plaintext(textBody)));
        //console.log(JSON.stringify({titleWords, tagWords}));
        let aHit = testWords.some(word => {
          const hasHit =
            (titleWords && titleWords.has(word)) ||
            (tagWords && tagWords.has(word)) ||
            (bodyWords && bodyWords.has(word));
          return hasHit;
        });
        return !!aHit;
      } catch (err) {
        console.error(err);
        return true;
      }
    };
  },

  /**
   * Given a set of postIds of relevant questions, reindex the answers
   * with fields from the question to allow inclusion in relevance.
   * @param {string} postIdsPathPath - Path to the ExtendedQuestionIds.json file.
   * @param {ElasticClient} client
   * @param {ElasticType} type - of the documents to store
   * @param {string} indexPrefix - Prefix for elastic client index name
   * @param {PercentCallback} onProgress - progress callback
   */
  extendAnswersFromQuestions: async function (postIdsPath, client, indexPrefix, onProgress) {
    // Read ExtendedQuestionIds.json to get post Ids
    const postIdsArray = JSON.parse(await fs.readFile(postIdsPath));
    const postIds = new Set(postIdsArray);

    let linesRead = 0;
    let totalHits = 0;
    let promiseBatch = [];
    // For each question, locate answers and reindex those answers with extended value.
    for (const questionId of postIds) {
      if (++linesRead % 20 == 0) {
        await Promise.all(promiseBatch);
        promiseBatch = [];
      }
      if (linesRead % 100 == 0) {
        if (onProgress) {
          onProgress(linesRead, totalHits, 100 * linesRead / postIds.size);
        }
      }

      promiseBatch.push(
        extendId(client, indexPrefix, questionId)
          .then(results => { totalHits += results; })
          .catch(reason => { /* do nothing, probably removed by tag sanitization */ })
      );
    }
    return Promise.all(promiseBatch);
  },

  /**
   * Given a set of postIds of relevant questions, index stackexchange
   * xml files into elasticsearch database. Posts.xml must be indexed first.
   * @param {string} questionsPath - Path to the Questions.json file.
   * @param {ElasticClient} client 
   * @param {ElasticType} type - of the documents to store
   * @param {string} indexPrefix - Prefix for elastic client index name 
   * @param {PercentCallback} onProgress - progress callback
   * @param {Set.<number>} userIds - Ids of users used in Posts and Comments
   */
  indexFromPostIds: async function (postIdsPath, client, type, indexPrefix, onProgress, userIds) {
    // Read PostIds.json to get post Ids
    const postIdsArray = JSON.parse(await fs.readFile(postIdsPath));
    const postIds = new Set(postIdsArray);

    // Delete existing index
    try {
      await elasticClient.deleteIndex(client, indexPrefix + type);
    } catch (err) { } // OK if index does not exist
    await elasticClient.createIndex(client, indexPrefix + type, type);

    // Index appropriate .xml in the same directory as PostIds.json
    if (!elasticClient.nameMappings[type]) throw new Error('Unsupported type: ' + type);
    const filePath = path.join(path.dirname(postIdsPath), elasticClient.nameMappings[type]);
    if (!(await fs.exists(filePath))) {
      throw new Error('file ' + elasticClient.nameMappings[type] + ' must exist in same directory as PostIds.json');
    }

    // For sepost, we will add votes. Need to total votes first.
    let voteTotals;
    let votesPath = path.join(path.dirname(postIdsPath), 'Votes.xml');

    if (type == 'sepost') {
      if (await fs.exists(votesPath)) {
        voteTotals = await elasticReader.totalVotes(votesPath, postIds, onProgress);
      } else {
        console.log('Votes.xml not found');
      }
    }

    // Setup appropriate function to determine if a lineObject should be indexed.
    const shouldIndexByType = {
      sepost: async lineObject => postIds.has(lineObject.Id),
      secomment: async lineObject => postIds.has(lineObject.PostId),
      seuser: async lineObject => {
        if (lineObject.Id < 0) return false;
        //return elasticClient.multiNeeded.promiseNeeded(client, indexPrefix, 'seuser', lineObject.Id);
        return userIds.has(lineObject.Id);
      },
      sepostlink: async lineObject => postIds.has(lineObject.PostId) || postIds.has(lineObject.RelatedPostId),
    };
    const shouldIndex = shouldIndexByType[type];
    let documentCount = 0;

    await readFile(
      filePath,
      type,
      async (lineObject) => {
        if (await shouldIndex(lineObject)) {
          documentCount++;
          // Posts are extended by vote count from Votes.xml
          if (type == 'sepost' && voteTotals) {
            lineObject.VoteCount = voteTotals.get(lineObject.Id) || 0;
          }
          // We store userids for use in indexing users
          if (type == 'sepost') {
            userIds.add(lineObject.OwnerUserId);
          } else if (type == 'secomment') {
            userIds.add(lineObject.UserId);
          }
          return elasticClient.putDocument(client, indexPrefix + type, type, lineObject);
        }
      },
      (fileSize, bytesRead, linesRead) => {
        // Rewrite onProgress return from readFile with local onProgress call.
        if (onProgress) {
          onProgress(linesRead, documentCount, 100 * bytesRead / fileSize, 'indexing ' + type);
        }
      },
      // When the input file is closed, process any remaining requests
      //() => {
      //  elasticClient.multiNeeded.flushRequests(client, indexPrefix, type)
      //    .catch((onrejected) => {
      //     console.log('Error flushing multiNeeded: ' + onrejected);
      //    });
      //},
    );
    return elasticClient.promiseRefreshIndex(client, indexPrefix + type);
  },

  readFiles: async function (directoryPath, client, indexPrefix) {
    for (const fileType in elasticClient.nameMappings) {
      const fileName = elasticClient.nameMappings[fileType];
      const filePath = path.join(directoryPath, fileName);
      // Make sure the file exists
      try {
        await fs.access(filePath);
      } catch (err) {
        throw new Error('File ' + fileName + ' does not exist in directory ' + directoryPath);
      }

      await indexFile(filePath, fileType, client, indexPrefix);
    }
  },

  /**
   * Generate a PostIds.json file given the Questions.json file, that contains both questions
   * and answers to process, as well as related and linked posts. This method will reject questions
   * and answers that match the exclude tags.
   * @param {string} questionsPath - the path to the file Questions.json
   * @param {PercentCallback} onProgress - callback to show progress (or null)
   * @param excludeTags {string} excludeTags - space-separated list of tags to exclude from index
   * 
   */
  getAllPostIds: async function (questionsPath, onProgress, excludeTags) {
    // Read Questions.json to get post Ids
    let postIdsArray = (JSON.parse(await fs.readFile(questionsPath))).postIds;
    const questionIds = new Set(postIdsArray); // The original questionsIds matching tags
    const extendedQuestionIds = new Set(postIdsArray); // All questionsIds including links 
    const postIds = new Set(postIdsArray); // extended Ids including links and answers
    postIdsArray = null; // release unneeded memory

    const postsPath = path.join(path.dirname(questionsPath), 'Posts.xml');
    const postLinksPath = path.join(path.dirname(questionsPath), 'PostLinks.xml');
    if (!(await fs.exists(postsPath))) {
      throw new Error('Posts.xml must exist in same directory as Questions.json: ' + postsPath);
    }
    if (!(await fs.exists(postLinksPath))) {
      throw new Error('PostLinks.xml must exist in same directory as Questions.json: ' + postLinksPath);
    }

    // Add related and linked posts
    let documentCount = 0;
    await readFile(
      postLinksPath,
      'sepostlink',
      async (lineObject) => {
        if (questionIds.has(lineObject.PostId)) {
          documentCount++;
          postIds.add(lineObject.RelatedPostId);
          extendedQuestionIds.add(lineObject.RelatedPostId);
        }
        if (questionIds.has(lineObject.RelatedPostId)) {
          documentCount++;
          postIds.add(lineObject.PostId);
          extendedQuestionIds.add(lineObject.PostId);
        }
      },
      (fileSize, bytesRead, linesRead) => {
        // Rewrite onProgress return from readFile with local onProgress call.
        if (onProgress) {
          onProgress(linesRead, documentCount, 100 * bytesRead / fileSize, '% PostLinks processed');
        }
      },
      null,
    );

    // Add answers to questions plus fields from questions. Reject any questions according to exclude tags.
    documentCount = 0;
    const shouldReject = elasticReader.makeDoesMatch(excludeTags || parameters.tagsToExclude, false);

    await readFile(
      postsPath,
      'sepost',
      async (lineObject) => {
        // Reject questions with exclude tags
        if (lineObject.PostTypeId == POSTTYPEID_QUESTION &&
            extendedQuestionIds.has(lineObject.Id) &&
            shouldReject(lineObject)) {
          extendedQuestionIds.delete(lineObject.Id);
          postIds.delete(lineObject.Id);
        }

        // Add answers but not if rejected
        if (lineObject.PostTypeId == POSTTYPEID_ANSWER &&
            extendedQuestionIds.has(lineObject.ParentId) &&
            !shouldReject(lineObject)) {
          postIds.add(lineObject.Id);
          documentCount++;
        }
      },
      (fileSize, bytesRead, linesRead) => {
        // Rewrite onProgress return from readFile with local onProgress call.
        if (onProgress) {
          onProgress(linesRead, documentCount, 100 * bytesRead / fileSize, '% Posts processed');
        }
      },
      null,
    );
    return [postIds, documentCount, extendedQuestionIds];
  },

  /**
   * @async
   * @param {string} filePath - path to the Posts XML file to process
   * @param {string} tags - space-separated list of tags (including title words) to include
   * @param {PercentCallback} onProgress - progress callback
   * @return {number[]} - list of Post Ids of questions with these tags 
   */
  getQuestionIdsByTags: async function (filePath, includeTags, onProgress) {
    const postIds = [];

    const shouldInclude = elasticReader.makeDoesMatch(includeTags || parameters.tagsToInclude, true);
    // return true if this post is a question and contains the tag
    async function processPost(lineObject) {
      // Only process Questions
      if (!lineObject ||
          !lineObject.PostTypeId ||
          (lineObject.PostTypeId != POSTTYPEID_QUESTION)) {
        return false;
      }

      // check the tag. We'll assume that a word occurring in the title is
      // equivalent to a tag. Note we are not rejecting yet.
      if (shouldInclude(lineObject)) {
        postIds.push(lineObject.Id);
      }
    }

    // Read through the whole file, determining matching Ids
    await readFile(filePath, 'sepost', processPost, (fileSize, bytesRead, linesRead) => {
      // Rewrite onProgress return from readFile with local onProgress call.
      if (onProgress) {
        onProgress(linesRead, postIds.length, 100 * bytesRead / fileSize);
      }
    });
    return postIds;
  },

  /**
   * Accumulate votes from Votes.xml, only including votes for needed ids. 
   * @param {string} filePath - path to Votes.xml file
   * @param {Set.<number>} postIds - Set of ids that will be included in the index
   * @param {PercentCallback} onProgress - progress callback
   * @return {Map.<number, number>} mapping from postId to vote count
   */
  totalVotes: async function (filePath, postIds, onProgress) {
    // Read Votes.xml file, accumulating vote totals
    const voteTotals = new Map();
    let documentCount = 0;
    await readFile(
      filePath,
      null,
      async (lineObject) => {
        const postIdNum = Number(lineObject.PostId);
        if (postIds.has(postIdNum)) {
          let count = voteTotals.get(postIdNum);
          if (count === undefined) {
            count = 0;
            documentCount++;
          }
          if (lineObject.VoteTypeId == VOTETYPEID_UPMOD) {
            count++;
          } else if (lineObject.VoteTypeId == VOTETYPEID_DOWNMOD) {
            count--;
          }
          voteTotals.set(postIdNum, count);
        }
      },
      (fileSize, bytesRead, linesRead) => {
        // Rewrite onProgress return from readFile with local onProgress call.
        if (onProgress) {
          onProgress(linesRead, documentCount, 100 * bytesRead / fileSize, '% completion totalling Votes');
        }
      },
    );
    return voteTotals;
  },
};
