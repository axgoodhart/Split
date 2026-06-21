#!/usr/bin/env python3
import json
import os
from datetime import datetime
from pathlib import Path

def get_message_text_parts(message):
    """Extract visible text parts from text and multimodal_text messages"""
    if not message:
        return []

    content = message.get('content', {})
    parts = content.get('parts', [])
    content_type = content.get('content_type')

    if content_type and content_type not in ('text', 'multimodal_text'):
        return []

    text_parts = []
    for part in parts:
        if isinstance(part, str) and part.strip():
            text_parts.append(part)
        elif isinstance(part, dict) and part.get('content_type') == 'audio_transcription' and part.get('text'):
            text_parts.append(f"[Transcript]: {part['text']}")
        elif isinstance(part, dict) and part.get('content_type') == 'image_asset_pointer':
            pointer = part.get('asset_pointer', '')
            label = pointer.split('/')[-1] if pointer else 'image attachment'
            text_parts.append(f"[File]: {label}")

    return text_parts

def is_display_message(message):
    """Match ChatGPT export display rules for visible conversation messages"""
    if not message:
        return False
    if not message.get('id'):
        return False
    author = message.get('author', {})
    if author.get('role') == 'system' and not message.get('metadata', {}).get('is_user_system_message'):
        return False
    return len(get_message_text_parts(message)) > 0

def get_messages_in_order(conversation):
    """
    Extract visible messages in display order.
    New ChatGPT exports omit children, so walk from current_node through parents.
    """
    mapping = conversation.get('mapping', {})
    if not mapping:
        return []

    current_node = conversation.get('current_node')
    if current_node and current_node in mapping:
        result = []
        seen = set()

        while current_node and current_node in mapping and current_node not in seen:
            seen.add(current_node)
            node = mapping[current_node]
            if is_display_message(node.get('message')):
                result.append(node)
            current_node = node.get('parent')

        return list(reversed(result))

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

            if is_display_message(node.get('message')):
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
    messages = get_messages_in_order(conversation)

    # Format each message
    for msg_node in messages:
        message = msg_node.get('message', {})
        if not message:
            continue

        author = message.get('author', {})
        role = author.get('role', 'unknown').upper()
        content = message.get('content', {})
        parts = get_message_text_parts(message)
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

    # Find new-format ChatGPT export chunks
    source_dir = script_dir / 'Split New Format'
    json_files = sorted(source_dir.glob('conversations-*.json'))

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
