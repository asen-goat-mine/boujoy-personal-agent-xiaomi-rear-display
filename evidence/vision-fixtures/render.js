ObjC.import('Foundation');
ObjC.import('AppKit');

function run(args) {
  if (args.length !== 1) throw Error('Expected an existing output directory');
  const width = 1080, height = 1920;
  const frames = [['ALPHA', 'Park', '12.90'], ['BRAVO', 'Library', '18.50'], ['DELTA', 'Market', '24.00']];
  for (const [label, place, price] of frames) {
    const bitmap = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(null, width, height, 8, 4, true, false, $.NSCalibratedRGBColorSpace, 0, 0);
    $.NSGraphicsContext.saveGraphicsState;
    $.NSGraphicsContext.setCurrentContext($.NSGraphicsContext.graphicsContextWithBitmapImageRep(bitmap));
    $.NSColor.whiteColor.setFill;
    $.NSRectFill($.NSMakeRect(0, 0, width, height));
    const rows = [[label, 78, 1640], ['查找附近地点', 54, 1410], ['Destination: ' + place, 52, 1210], ['合计 ¥' + price, 46, 1010], ['返回', 48, 350]];
    for (const [line, size, position] of rows) {
      const attributes = $.NSMutableDictionary.alloc.init;
      attributes.setObjectForKey($.NSFont.fontWithNameSize('PingFangSC-Regular', size), $.NSFontAttributeName);
      attributes.setObjectForKey($.NSColor.blackColor, $.NSForegroundColorAttributeName);
      $(line).drawAtPointWithAttributes($.NSMakePoint(70, position), attributes);
    }
    $.NSGraphicsContext.restoreGraphicsState;
    const file = args[0] + '/' + label + '.png';
    if (!bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({})).writeToFileAtomically(file, true)) throw Error('Could not create ' + file);
  }
}
