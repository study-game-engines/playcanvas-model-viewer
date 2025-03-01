import {
    BLEND_NORMAL,
    createShaderFromCode,
    CULLFACE_BACK,
    CULLFACE_NONE,
    GraphicsDevice,
    Material,
    SEMANTIC_POSITION,
    SEMANTIC_ATTR13
} from "playcanvas";

const splatVS = `
    attribute vec3 vertex_position;

    uniform mat4 matrix_model;
    uniform mat4 matrix_view;
    uniform mat4 matrix_projection;
    uniform mat4 matrix_viewProjection;

    uniform vec2 viewport;

    varying vec2 texCoord;
    varying vec4 color;

    mat3 quatToMat3(vec3 R)
    {
        float x = R.x;
        float y = R.y;
        float z = R.z;
        float w = sqrt(1.0 - dot(R, R));

        return mat3(
            1.0 - 2.0 * (z * z + w * w),
                2.0 * (y * z + x * w),
                2.0 * (y * w - x * z),

                2.0 * (y * z - x * w),
            1.0 - 2.0 * (y * y + w * w),
                2.0 * (z * w + x * y),

                2.0 * (y * w + x * z),
                2.0 * (z * w - x * y),
            1.0 - 2.0 * (y * y + z * z)
        );
    }

    uniform vec4 tex_params;
    uniform sampler2D splatColor;
    uniform highp sampler2D splatScale;
    uniform highp sampler2D splatRotation;
    uniform highp sampler2D splatCenter;

    #ifdef WEBGPU

        attribute uint vertex_id;
        ivec2 dataUV;
        void evalDataUV() {

            // turn vertex_id into int grid coordinates
            ivec2 textureSize = ivec2(tex_params.xy);
            vec2 invTextureSize = tex_params.zw;

            int gridV = int(float(vertex_id) * invTextureSize.x);
            int gridU = int(vertex_id - gridV * textureSize.x);
            dataUV = ivec2(gridU, gridV);
        }

        vec4 getColor() {
            return texelFetch(splatColor, dataUV, 0);
        }

        vec3 getScale() {
            return texelFetch(splatScale, dataUV, 0).xyz;
        }

        vec3 getRotation() {
            return texelFetch(splatRotation, dataUV, 0).xyz;
        }

        vec3 getCenter() {
            return texelFetch(splatCenter, dataUV, 0).xyz;
        }

    #else

        // TODO: use texture2DLodEXT on WebGL

        attribute float vertex_id;
        vec2 dataUV;
        void evalDataUV() {
            vec2 textureSize = tex_params.xy;
            vec2 invTextureSize = tex_params.zw;

            // turn vertex_id into int grid coordinates
            float gridV = floor(vertex_id * invTextureSize.x);
            float gridU = vertex_id - (gridV * textureSize.x);

            // convert grid coordinates to uv coordinates with half pixel offset
            dataUV = vec2(gridU, gridV) * invTextureSize + (0.5 * invTextureSize);
        }

        vec4 getColor() {
            return texture(splatColor, dataUV);
        }

        vec3 getScale() {
            return texture(splatScale, dataUV).xyz;
        }

        vec3 getRotation() {
            return texture(splatRotation, dataUV).xyz;
        }

        vec3 getCenter() {
            return texture(splatCenter, dataUV).xyz;
        }

    #endif

    void computeCov3d(in mat3 rot, in vec3 scale, out vec3 covA, out vec3 covB)
    {
        // M = S * R
        float M[9] = float[9](
            scale.x * rot[0][0],
            scale.x * rot[0][1],
            scale.x * rot[0][2],
            scale.y * rot[1][0],
            scale.y * rot[1][1],
            scale.y * rot[1][2],
            scale.z * rot[2][0],
            scale.z * rot[2][1],
            scale.z * rot[2][2]
        );

        covA = vec3(
            M[0] * M[0] + M[3] * M[3] + M[6] * M[6],
            M[0] * M[1] + M[3] * M[4] + M[6] * M[7],
            M[0] * M[2] + M[3] * M[5] + M[6] * M[8]
        );

        covB = vec3(
            M[1] * M[1] + M[4] * M[4] + M[7] * M[7],
            M[1] * M[2] + M[4] * M[5] + M[7] * M[8],
            M[2] * M[2] + M[5] * M[5] + M[8] * M[8]
        );
    }

    void main(void)
    {
        evalDataUV();

        vec3 center = getCenter();
        vec4 splat_cam = matrix_view * matrix_model * vec4(center, 1.0);
        vec4 splat_proj = matrix_projection * splat_cam;

        // cull behind camera
        if (splat_proj.z < -splat_proj.w) {
            gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
            return;
        }

        vec3 scale = getScale();
        vec3 rotation = getRotation();

        color = getColor();

        #ifdef DEBUG_RENDER
            vec3 local = quatToMat3(rotation) * (vertex_position * scale * 2.0) + center;
            gl_Position = matrix_viewProjection * matrix_model * vec4(local, 1.0);
        #else
            vec3 splat_cova;
            vec3 splat_covb;
            computeCov3d(mat3(matrix_model) * quatToMat3(rotation), scale, splat_cova, splat_covb);

            mat3 Vrk = mat3(
                splat_cova.x, splat_cova.y, splat_cova.z, 
                splat_cova.y, splat_covb.x, splat_covb.y,
                splat_cova.z, splat_covb.y, splat_covb.z
            );

            float focal = viewport.x * matrix_projection[0][0];

            mat3 J = mat3(
                focal / splat_cam.z, 0., -(focal * splat_cam.x) / (splat_cam.z * splat_cam.z), 
                0., focal / splat_cam.z, -(focal * splat_cam.y) / (splat_cam.z * splat_cam.z), 
                0., 0., 0.
            );

            mat3 W = transpose(mat3(matrix_view));
            mat3 T = W * J;
            mat3 cov = transpose(T) * Vrk * T;

            float diagonal1 = cov[0][0] + 0.3;
            float offDiagonal = cov[0][1];
            float diagonal2 = cov[1][1] + 0.3;

            float mid = 0.5 * (diagonal1 + diagonal2);
            float radius = length(vec2((diagonal1 - diagonal2) / 2.0, offDiagonal));
            float lambda1 = mid + radius;
            float lambda2 = max(mid - radius, 0.1);
            vec2 diagonalVector = normalize(vec2(offDiagonal, lambda1 - diagonal1));
            vec2 v1 = min(sqrt(2.0 * lambda1), 1024.0) * diagonalVector;
            vec2 v2 = min(sqrt(2.0 * lambda2), 1024.0) * vec2(diagonalVector.y, -diagonalVector.x);

            gl_Position = splat_proj +
                vec4((vertex_position.x * v1 + vertex_position.y * v2) / viewport * 2.0,
                    0.0, 0.0) * splat_proj.w;

            texCoord = vertex_position.xy * 2.0;
        #endif
    }
`;

const splatFS = /* glsl_ */ `
    varying vec2 texCoord;
    varying vec4 color;

    void main(void)
    {
        #ifdef DEBUG_RENDER

            if (color.a < 0.2) discard;
            gl_FragColor = color;

        #else

            float A = -dot(texCoord, texCoord);
            if (A < -4.0) discard;
            float B = exp(A) * color.a;
            gl_FragColor = vec4(color.rgb, B);

        #endif
    }
`;

const createSplatMaterial = (device: GraphicsDevice, debugRender = false) => {
    const result = new Material();
    result.name = 'splatMaterial';
    result.cull = debugRender ? CULLFACE_BACK : CULLFACE_NONE;
    result.blendType = BLEND_NORMAL;
    result.depthWrite = false;

    const defines = debugRender ? '#define DEBUG_RENDER\n' : '';
    const vs = defines + splatVS;
    const fs = defines + splatFS;

    result.shader = createShaderFromCode(device, vs, fs, `splatShader-${debugRender}`, {
        vertex_position: SEMANTIC_POSITION,
        vertex_id: SEMANTIC_ATTR13
    });

    result.update();

    return result;
};

export { createSplatMaterial };
