import {NextRequest,NextResponse} from 'next/server';
import {timingSafeEqual} from 'node:crypto';

// El catálogo privado nunca se entrega mediante una galería anónima.
export function proxy(request:NextRequest){
  if(!process.env.ERP_CATALOG_BUCKET&&!process.env.ERP_CATALOG_FILE)return NextResponse.next();
  const user=process.env.ERP_CATALOG_APP_USER,password=process.env.ERP_CATALOG_APP_PASSWORD;
  if(!user||!password)return new NextResponse('Configura el acceso privado de ImageNormalization.',{status:503});
  const expected=Buffer.from('Basic '+Buffer.from(`${user}:${password}`).toString('base64'));
  const supplied=Buffer.from(request.headers.get('authorization')??'');
  if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))return new NextResponse('Acceso privado',{status:401,headers:{'WWW-Authenticate':'Basic realm="ImageNormalization ERP", charset="UTF-8"','Cache-Control':'no-store'}});
  return NextResponse.next();
}
export const config={matcher:['/((?!_next/static|_next/image|favicon.ico).*)']};
