/**
 * Tests that read-in XML data is indexed properly by tags.
 */

const assert = require('chai').assert;
const prettyjson = require('prettyjson'); // eslint-disable-line no-unused-vars
const path = require('path');
const elasticClient = require('../../lib/elasticClient');

const {getQuestionIdsByTags, indexPostsFromPostIds} = require('../../lib/elasticReader');

const postsPath = path.join(__dirname, '..', 'data', 'Posts.xml');
const questionsPath = path.join(__dirname, '..', 'data', 'Questions.json');
const TEST_HOST = 'localhost:9200';
const TEST_INDEX_PREFIX = 'testindex_';

describe('indexing of xml files works by tag', function () {
  this.timeout(10000);
  it('gets correct Ids by tag', async function () {
    const postIds = await getQuestionIdsByTags(postsPath, ['site-promotion']);
    //console.log('postIds is\n' + prettyjson.render(postIds));
    assert(postIds.length == 1, 'Found 1 match');
    assert(postIds[0] === 3, 'Matches Id 3');
  });

  it('finds a tag in a title only', async function () {
    const postIds = await getQuestionIdsByTags(postsPath, ['FAQ']);
    //console.log('postIds is\n' + prettyjson.render(postIds));
    assert(postIds.length == 1, 'Found 1 match');
    assert(postIds[0] === 2, 'Matches Id 2');
  });

  it('returns multiple Ids and also matches lower case', async function () {
    const postIds = await getQuestionIdsByTags(postsPath, ['site-promotion', 'faq']);
    //console.log('postIds is\n' + prettyjson.render(postIds));
    assert(postIds.length == 2, 'Found 2 match');
    assert(postIds.includes(3), 'Matches Id 3');
    assert(postIds.includes(2), 'Matches Id 2');
  });

  it('finds tags at end and beginning of title', async function () {
    const postIds = await getQuestionIdsByTags(postsPath, ['off-topic', 'the']);
    //console.log('postIds is\n' + prettyjson.render(postIds));
    assert(postIds.length == 3, 'Found 3 match');
    assert(postIds.includes(3), 'Matches Id 3');
    assert(postIds.includes(1), 'Matches Id 1');
    assert(postIds.includes(7), 'Matches Id 7');
  });

  it('indexes posts using Questions.json', async function () {
    const client = elasticClient.makeClient({host: TEST_HOST});
    await indexPostsFromPostIds(questionsPath, client, TEST_INDEX_PREFIX);
    await elasticClient.promiseRefreshIndex(client, TEST_INDEX_PREFIX + 'sepost');
    const res = await elasticClient.getAllDocuments(client, TEST_INDEX_PREFIX + 'sepost');
    assert.equal(res.hits.total, 5, 'Indexed 5 items');

    const indexedPosts = res.hits.hits.map(hit => hit._id);
    const questionIds = ['1', '2', '4'];
    const answerIds = ['6', '8'];
    assert(questionIds.every(id => indexedPosts.includes(id)), 'All questions indexed');
    assert(answerIds.every(id => indexedPosts.includes(id)), 'All answers indexed');
  });
});
