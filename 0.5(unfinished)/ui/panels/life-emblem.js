// Same blue-cell galaxy as website/qq-agent/assets/qa3/life.js.
// Its eight-generation cycle is compiled once; playback needs no JS timer.
const SIZE=13,CELL=5,PAD=2;
const seed=['111111011','111111011','000000011','110000011','110000011','110000011','110000000','110111111','110111111'];
let grid=Array.from({length:SIZE},()=>Array(SIZE).fill(0));
for(let y=0;y<seed.length;y++)for(let x=0;x<seed[y].length;x++)grid[y+2][x+2]=Number(seed[y][x]);
const frames=[];
for(let phase=0;phase<=8;phase++){
  const cells=[];
  for(let y=0;y<SIZE;y++)for(let x=0;x<SIZE;x++)if(grid[y][x])cells.push(`M${x*CELL+PAD} ${y*CELL+PAD}h4v4h-4z`);
  frames.push(cells.join(''));
  grid=grid.map((row,y)=>row.map((alive,x)=>{
    let neighbors=0;
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)if(dx||dy)neighbors+=grid[y+dy]?.[x+dx]??0;
    return Number(neighbors===3||alive&&neighbors===2);
  }));
}
export const LIFE_EMBLEM_FRAMES=Object.freeze(frames);
