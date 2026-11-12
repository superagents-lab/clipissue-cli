import { appendFileSync } from 'node:fs';
globalThis.fetch = async (url, init) => {
  if (url !== 'https://api.linear.app/graphql') throw new Error('Unexpected endpoint');
  const body = JSON.parse(init.body);
  appendFileSync(process.env.CLIPISSUE_TEST_REQUEST_LOG, `${JSON.stringify({ ...body, authorization: init.headers.Authorization })}\n`);
  return Response.json({ data: { searchIssues: { nodes: [] } } });
};
