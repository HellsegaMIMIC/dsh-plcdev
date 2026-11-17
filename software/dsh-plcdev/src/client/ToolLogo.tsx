import React from 'react';
import {toolLogos} from './tool-logos.mjs';

export type ToolLogoProps = {
  tool: string;
  size?: number;
  className?: string;
};

/** Decorative tool identity; the adjacent text supplies its accessible name. */
export function ToolLogo({tool,size=22,className}:ToolLogoProps) {
  const key=tool==='plc'?'openplc':tool;
  const source=Object.hasOwn(toolLogos,key)?toolLogos[key]:null;
  if(!source)return null;
  return <img className={'plcdev-tool-logo'+(className?' '+className:'')} src={source}
    width={size} height={size} alt="" aria-hidden="true" draggable={false}
    style={{width:size,height:size,objectFit:'contain',display:'inline-block',flex:'0 0 auto',verticalAlign:'middle'}}/>;
}
