import type { Request,Response,NextFunction } from 'express';
import { ZodError } from 'zod';
import { logger } from './logger';
export class ApiError extends Error {
  constructor(public code:string,message:string,public status=400,public details?:unknown){super(message);}
}
export function errorHandler(error:unknown,_req:Request,res:Response,_next:NextFunction){
  let status=500,code='INTERNAL_ERROR',message='Could not complete this request. Please retry.',details:unknown;
  if(error instanceof ApiError){({status,code,message,details}=error);}
  else if(error instanceof ZodError){status=400;code='VALIDATION_FAILED';message='Check the highlighted fields and try again.';details=error.issues.map(v=>({path:v.path,message:v.message}));}
  else if(typeof error==='object'&&error&&'type'in error&&error.type==='entity.parse.failed'){status=400;code='VALIDATION_FAILED';message='Send a valid JSON request body.';}
  else if(typeof error==='object'&&error&&'type'in error&&error.type==='entity.too.large'){status=413;code='REQUEST_TOO_LARGE';message='Keep this request below 256 KB.';}
  else if(typeof error==='object'&&error&&'code'in error){if(error.code==='P2025'){status=404;code='NOT_FOUND';message='This item could not be found.';}else if(error.code==='P2002'){status=409;code='CONFLICT';message='An item with this identity already exists.';}}
  if(status>=500)logger.error({requestId:res.locals.requestId,error:error instanceof Error?error.message:'unknown'},'request failed');
  res.status(status).json({error:{code,message,...(details===undefined?{}:{details}),requestId:res.locals.requestId}});
}
