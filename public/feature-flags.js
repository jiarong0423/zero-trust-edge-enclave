// Which optional sender controls to show, decided from the `features` object the server returns with the
// recipient list. Anything missing or not exactly true is off, so an older server (no `features`) shows
// only the plain list.
export function featureVisibility(features) {
  const on = name => Boolean(features) && typeof features === 'object' && features[name] === true;
  return { findByName: on('findByName'), noteReader: on('noteReader'), ranking: on('ranking') };
}
