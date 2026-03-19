import React from 'react';

export default function ThinkingIndicator() {
  return (
    <div className="flex items-center gap-1 px-4 py-3">
      <div className="flex items-center gap-[5px]">
        {[0, 1, 2].map(i => (
          <div
            key={i}
            className="w-[5px] h-[5px] rounded-full bg-accent animate-thinking-dot"
            style={{ animationDelay: `${i * 0.16}s` }}
          />
        ))}
      </div>
    </div>
  );
}
