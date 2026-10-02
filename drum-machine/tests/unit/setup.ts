import 'fake-indexeddb/auto';

// jsdom has no canvas implementation; the waveform view skips drawing when this is null.
HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement['getContext'];
