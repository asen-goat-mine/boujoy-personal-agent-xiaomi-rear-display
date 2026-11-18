ObjC.import('Foundation');
ObjC.import('AppKit');
function run(argv){
  const width=1300,height=650,lines=['Title: Project Review','Date: 2031-10-20','Start: 09:00','End: 10:00'];
  // Draw directly into a private bitmap: a browser compositor can duplicate
  // tiles under concurrent I/O, which is an ambiguous input, not an OCR fault.
  const bitmap=$.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(null,width,height,8,4,true,false,$.NSCalibratedRGBColorSpace,0,0);
  const font=$.NSFont.fontWithNameSize('Arial',36),attrs=$.NSMutableDictionary.alloc.init;
  attrs.setObjectForKey(font,$.NSFontAttributeName);attrs.setObjectForKey($.NSColor.blackColor,$.NSForegroundColorAttributeName);
  $.NSGraphicsContext.saveGraphicsState;
  try{
    $.NSGraphicsContext.setCurrentContext($.NSGraphicsContext.graphicsContextWithBitmapImageRep(bitmap));
    $.NSColor.whiteColor.setFill;$.NSRectFill($.NSMakeRect(0,0,width,height));
    for(let i=0;i<lines.length;i++)$(lines[i]).drawAtPointWithAttributes($.NSMakePoint(48,560-i*78),attrs);
  }finally{$.NSGraphicsContext.restoreGraphicsState;}
  if(!bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG,$({})).writeToFileAtomically(argv[0],true))throw Error('Fixture image could not be written');
  return JSON.stringify({renderer:'AppKit private NSBitmapImageRep',font:'36px Arial',width,height,text:lines.join('\n')});
}
