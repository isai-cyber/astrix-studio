// Creación de documentos y capas con la misma estructura JSON que "Project.mohoproj".
import { makeChannel } from './anim.js';

export const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 3) | 8).toString(16);
  }));

const now = () => new Date().toString().slice(0, 24);

export function newDocument(width = 1920, height = 1080, endFrame = 120, fps = 24) {
  return {
    mime_type: 'application/x-vnd.lm_mohodoc',
    version: 1040, major_version: 1, rev_version: 0, comment: '',
    doc_uuid: uuid(), created_date: now(), modified_date: now(),
    project_data: {
      width, height, start_frame: 1, end_frame: endFrame, fps,
      back_color: { r: 234, g: 234, b: 234, a: 255 },
      noise_grain: 0, pixelation: 0, antialiasing: true, depth_sort: false, distance_sort: false,
      depth_of_field: false, focus_distance: 2.0, focus_range: 1.0, focus_blur: 0.016461,
      global_render_style_fill_style: 0, global_render_style_line_style: 0,
      global_render_style_layer_style: 0, global_render_style_minimize_randomness: true,
      stereo_mode: 0, stereo_separation: -1.0, extra_swf_frame: false,
      color_palette: 'Basic Colors.png', soundtrack: '',
    },
    styles: [], layercomps: [], metadata: {}, action_refs: [],
    animated_values: {
      camera_track: makeChannel('Vec3', { x: 0, y: 0, z: 3.732051 }),
      camera_zoom: makeChannel('Val', 2.0),
      camera_roll: makeChannel('Val', 0.0),
      camera_pan_tilt: makeChannel('Vec2', { x: 0, y: 0 }),
      timeline_markers: makeChannel('String', ''),
    },
    layers: [],
  };
}

function baseLayer(type, name) {
  return {
    type, name, uuid: uuid(), label_col: 0, visible: true, shown_in_timeline: true,
    origin: { x: 0, y: 0 }, parent_bone: -1, flexi_bone_subset: '', masking: 0, blend_mode: 0,
    transforms: {
      translation: makeChannel('Vec3', { x: 0, y: 0, z: 0 }),
      scale: makeChannel('Vec3', { x: 1, y: 1, z: 1 }),
      rotation_x: makeChannel('Val', 0), rotation_y: makeChannel('Val', 0), rotation_z: makeChannel('Val', 0),
      flip_h: makeChannel('Bool', false), flip_v: makeChannel('Bool', false),
    },
    layer_effects: makeEffects(),
    timing_offset: 0,
  };
}

export function makeEffects() {
  return {
    visibility: makeChannel('Bool', true), blur: makeChannel('Val', 0), alpha: makeChannel('Val', 1),
    ambient_occlusion: makeChannel('Val', 0), threshold: makeChannel('Val', 0),
    noise: makeChannel('Val', 0), pixelation: makeChannel('Val', 0),
  };
}

// Imagen o video (Moho usa ImageLayer para ambos). width/height en unidades del documento.
export function makeImageLayer(path, width, height, name) {
  return {
    ...baseLayer('ImageLayer', name || path.split('/').pop()),
    image_fileref: { relativeTo: 'Project', path }, image_path: path,
    interpreted_fps: -1, movie_looping: false, reverse_movie: false,
    persist_first_frame: false, persist_last_frame: false,
    width, height, image_cropped: false, actions: [],
  };
}

export function makeAudioLayer(path, name) {
  return {
    ...baseLayer('AudioLayer', name || path.split('/').pop()),
    audio_fileref: { relativeTo: 'Project', path }, audio_path: path, spatial_positioning: false,
    audio_level: makeChannel('Val', 1), audio_jump: makeChannel('Val', 0), audio_text: '',
    shown_in_timeline: false,
  };
}

export function makeGroupLayer(name = 'Grupo') {
  return { ...baseLayer('GroupLayer', name), expanded: true, layers: [] };
}

export function makeBoneLayer(name = 'Huesos') {
  return { ...baseLayer('BoneLayer', name), expanded: true, layers: [],
    skeleton: { type: 'Skeleton', binding_mode: 1, bones: [] } };
}

export function makeBone(name, parent, x, y, angle, length) {
  return {
    type: 'Bone', name, parent, length, strength: 1.0, selected: false, hidden: false, shy: false,
    offset: { x: 0, y: 0 }, fixed_angle: false, constraints: false,
    min_constraint: -1.22173, max_constraint: 1.22173,
    anim_pos: makeChannel('Vec2', { x, y }),
    anim_angle: makeChannel('Val', angle),
    anim_scale: makeChannel('Val', 1.0),
    flip_h: makeChannel('Bool', false), flip_v: makeChannel('Bool', false),
    target_bone: makeChannel('Val', -1), anim_parent: makeChannel('Val', parent),
  };
}

const col = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a: 1 };
};

// Forma de 4 puntos (rectángulo con smoothness 0, o elipse con smoothness ~0.39).
export function makeShapeLayer(kind, cx, cy, rx, ry, fillHex, lineHex) {
  const layer = { ...baseLayer('MeshLayer', kind === 'ellipse' ? 'Elipse' : 'Rectángulo') };
  const pts = kind === 'ellipse'
    ? [[cx, cy + ry], [cx + rx, cy], [cx, cy - ry], [cx - rx, cy]]
    : [[cx - rx, cy + ry], [cx + rx, cy + ry], [cx + rx, cy - ry], [cx - rx, cy - ry]];
  const smooth = kind === 'ellipse' ? 0.39 : 0;
  layer.mesh = {
    type: 'Mesh', curve_interpretation: 1, next_shape_id: 1, anim_shape_order: false,
    shape_order: makeChannel('String', '0'),
    points: pts.map(([x, y]) => ({
      type: 'Point', position: makeChannel('Vec2', { x, y }), width: makeChannel('Val', 1),
      parent: -2, selected: false, colored: false, color: makeChannel('Color', { r: 1, g: 1, b: 1, a: 1 }),
      color_strength: makeChannel('Val', 1), curves: [{ curve: 0, curve_points: 0 }],
    })),
    curves: [{
      type: 'Curve', num_points: 4, closed: true, profile_layer_uuid: '', profile_curve_id: -1, profile_repeat: 16,
      points: pts.map((_, i) => ({
        point: i, segments_on: true, smoothness: makeChannel('Val', smooth),
        weight_in: makeChannel('Val', 1), weight_out: makeChannel('Val', 1),
        offset_in: makeChannel('Val', 0), offset_out: makeChannel('Val', 0),
      })),
    }],
    shapes: [{
      type: 'Shape', name: 'S1', id: 0, selected: false, has_fill: true, has_outline: true, fill_allowed: true,
      edges: { curve: [0, 0, 0, 0], segment: [0, 1, 2, 3], flag: [0, 0, 0, 0] },
      style: {
        type: 'Style', name: '', uuid: uuid(),
        define_fill_color: true, fill_color: makeChannel('Color', col(fillHex)),
        define_line_width: true, line_width: 0.005556,
        define_line_col: true, line_color: makeChannel('Color', col(lineHex)), line_caps: 1,
      },
      inherited_style_name: '', inherited_style2_name: '',
    }],
    groups: [],
  };
  return layer;
}
