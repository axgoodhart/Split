#!/usr/bin/env python3
import json
import os
from datetime import datetime
from pathlib import Path

def get_messages_in_order(mapping):
    """
    Replicates the getMessagesInOrder function from index.html
    Traverses the conversation tree starting from root nodes
    Uses iterative approach with a stack to avoid recursion limits
    """
    if not mapping:
        return []

    result = []

    # Find root nodes where parent is null or missing
    roots = [node for node in mapping.values()
             if node.get('parent') is None or 'parent' not in node]

    if not roots:
        return []

    # Use iterative traversal with a stack instead of recursion
    for root in roots:
        stack = [root]

        while stack:
            node = stack.pop(0)  # Pop from front for breadth-first (maintains order)

            if not node:
                continue

            if 'message' in node and node['message']:
                result.append(node)

            if 'children' in node and node['children']:
                # Add children to stack in order
                for child_id in node['children']:
                    if child_id in mapping:
                        stack.append(mapping[child_id])

    return result

def format_timestamp(unix_timestamp):
    """Format unix timestamp to readable string"""
    if not unix_timestamp:
        return ''
    return datetime.fromtimestamp(unix_timestamp).strftime('%Y-%m-%d %H:%M:%S')

def export_conversation_to_markdown(conversation):
    """Convert a single conversation to markdown format"""
    md = ''
    title = conversation.get('title', 'Untitled Conversation')
    create_time = conversation.get('create_time')

    # Add conversation header
    md += f"## {title}\n\n"
    if create_time:
        md += f"*Created: {format_timestamp(create_time)}*\n\n"

    # Get messages in order using the tree traversal
    mapping = conversation.get('mapping', {})
    messages = get_messages_in_order(mapping)

    # Format each message
    for msg_node in messages:
        message = msg_node.get('message', {})
        if not message:
            continue

        author = message.get('author', {})
        role = author.get('role', 'unknown').upper()
        content = message.get('content', {})
        parts = content.get('parts', [])
        msg_time = message.get('create_time')

        if parts:
            # Join all parts with spaces (same as JavaScript .join(' '))
            text = ' '.join(str(part) for part in parts if part)
            timestamp = format_timestamp(msg_time) if msg_time else ''

            md += f"**{role}**"
            if timestamp:
                md += f" *({timestamp})*"
            md += f"\n\n{text}\n\n"
            md += "---\n\n"

    return md

def main():
    # Get current directory
    script_dir = Path(__file__).parent

    # Find all JSON files
    json_files = list(script_dir.glob('*.json'))

    print(f"Found {len(json_files)} JSON files")

    all_markdown = "# All Conversations Export\n\n"
    all_markdown += f"*Exported on {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}*\n\n"
    all_markdown += "---\n\n"

    conversation_count = 0

    for json_file in json_files:
        print(f"Processing {json_file.name}...")

        try:
            with open(json_file, 'r', encoding='utf-8') as f:
                data = json.load(f)

            # Handle both array and single object formats (same as JavaScript)
            conversations = data if isinstance(data, list) else [data]

            for conv in conversations:
                if conv and isinstance(conv, dict):
                    all_markdown += export_conversation_to_markdown(conv)
                    conversation_count += 1

        except Exception as e:
            print(f"Error processing {json_file.name}: {e}")
            continue

    # Write output file
    output_file = script_dir / 'all-conversations.md'
    with open(output_file, 'w', encoding='utf-8') as f:
        f.write(all_markdown)

    print(f"\n✓ Exported {conversation_count} conversations to {output_file}")
    print(f"  File size: {output_file.stat().st_size:,} bytes")

if __name__ == '__main__':
    main()
